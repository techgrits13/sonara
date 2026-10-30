'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { spawn, execFile } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const ytSearch = require('yt-search');

loadEnv();
const ROOT = __dirname;
const DATA_DIR = path.resolve(ROOT, process.env.DATA_DIR || 'data');
const MEDIA_DIR = path.resolve(ROOT, process.env.MEDIA_DIR || 'media');
const PORT = Number(process.env.PORT || 5000);
const HOST = process.env.HOST || (process.argv.includes('--lan') ? '0.0.0.0' : '127.0.0.1');
const SESSION_DAYS = Math.max(1, Math.min(365, Number(process.env.SESSION_DAYS || 30)));
const MAX_BODY = 1024 * 1024;
const MAX_UPLOAD = 2 * 1024 * 1024 * 1024;
const MEDIA_EXTENSIONS = new Set(['.mp3','.m4a','.aac','.ogg','.wav','.flac','.mp4','.m4v','.mov','.webm']);
const MIME = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.mp3':'audio/mpeg','.m4a':'audio/mp4','.aac':'audio/aac','.ogg':'audio/ogg','.wav':'audio/wav','.flac':'audio/flac','.mp4':'video/mp4','.m4v':'video/mp4','.mov':'video/quicktime','.webm':'video/webm'};
const PYTHON_CMD=process.env.PYTHON_PATH||(process.platform==='win32'?'python':'python3');
let bundledFfmpeg=null;try{bundledFfmpeg=require('ffmpeg-static')}catch{}
const FFMPEG_PATH=process.env.FFMPEG_PATH||(typeof bundledFfmpeg==='string'?bundledFfmpeg:'ffmpeg');
const DOWNLOAD_DIR=path.join(DATA_DIR,'downloads');
const videoInfoCache=new Map();
const videoInfoPending=new Map();
const searchResultCache=new Map();
let activeVideoDownloads=0;

fs.mkdirSync(DATA_DIR,{recursive:true});
fs.mkdirSync(MEDIA_DIR,{recursive:true});
fs.mkdirSync(DOWNLOAD_DIR,{recursive:true});
const db = new DatabaseSync(path.join(DATA_DIR,'snapclone.sqlite'));
db.exec(`PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE,name TEXT NOT NULL,password_salt TEXT NOT NULL,password_hash TEXT NOT NULL,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
CREATE TABLE IF NOT EXISTS favorites(user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,track_id TEXT NOT NULL,track_json TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(user_id,track_id));
CREATE TABLE IF NOT EXISTS playlists(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,name TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS playlists_user ON playlists(user_id,updated_at DESC);
CREATE TABLE IF NOT EXISTS playlist_shares(token TEXT PRIMARY KEY,playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS playlist_tracks(playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,track_id TEXT NOT NULL,track_json TEXT NOT NULL,position INTEGER NOT NULL,added_at INTEGER NOT NULL,PRIMARY KEY(playlist_id,track_id));
CREATE TABLE IF NOT EXISTS queue_items(user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,position INTEGER NOT NULL,track_id TEXT NOT NULL,track_json TEXT NOT NULL,PRIMARY KEY(user_id,position));
CREATE TABLE IF NOT EXISTS history(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,track_id TEXT NOT NULL,track_json TEXT NOT NULL,played_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS history_user ON history(user_id,played_at DESC);`);

const rateBuckets = new Map();
const strictRateBuckets = new Map();
const popularCache = { expiresAt: 0, items: [] };
let popularRefresh = null;
try {
  const cached = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'popular-cache.json'), 'utf8'));
  if (Array.isArray(cached.items)) popularCache.items = cached.items;
} catch {}
const prepared = {
  userByEmail: db.prepare('SELECT * FROM users WHERE email=?'),
  userById: db.prepare('SELECT id,email,name,created_at FROM users WHERE id=?'),
  insertUser: db.prepare('INSERT INTO users(id,email,name,password_salt,password_hash,created_at) VALUES(?,?,?,?,?,?)'),
  insertSession: db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)'),
  session: db.prepare('SELECT s.user_id,s.expires_at,u.email,u.name FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?'),
  deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash=?'),
  favorites: db.prepare('SELECT track_json,created_at FROM favorites WHERE user_id=? ORDER BY created_at DESC'),
  addFavorite: db.prepare('INSERT INTO favorites(user_id,track_id,track_json,created_at) VALUES(?,?,?,?) ON CONFLICT(user_id,track_id) DO UPDATE SET track_json=excluded.track_json'),
  removeFavorite: db.prepare('DELETE FROM favorites WHERE user_id=? AND track_id=?'),
  playlists: db.prepare('SELECT id,name,created_at,updated_at,(SELECT COUNT(*) FROM playlist_tracks pt WHERE pt.playlist_id=p.id) AS track_count FROM playlists p WHERE user_id=? ORDER BY updated_at DESC'),
  playlist: db.prepare('SELECT * FROM playlists WHERE id=? AND user_id=?'),
  createPlaylist: db.prepare('INSERT INTO playlists(id,user_id,name,created_at,updated_at) VALUES(?,?,?,?,?)'),
  renamePlaylist: db.prepare('UPDATE playlists SET name=?,updated_at=? WHERE id=? AND user_id=?'),
  deletePlaylist: db.prepare('DELETE FROM playlists WHERE id=? AND user_id=?'),
  playlistTracks: db.prepare('SELECT track_json,position,added_at FROM playlist_tracks WHERE playlist_id=? ORDER BY position,added_at'),
  addPlaylistTrack: db.prepare('INSERT INTO playlist_tracks(playlist_id,track_id,track_json,position,added_at) VALUES(?,?,?,?,?) ON CONFLICT(playlist_id,track_id) DO UPDATE SET track_json=excluded.track_json'),
  removePlaylistTrack: db.prepare('DELETE FROM playlist_tracks WHERE playlist_id=? AND track_id=?'),
  history: db.prepare('SELECT track_json,played_at FROM history WHERE user_id=? ORDER BY played_at DESC LIMIT 100'),
  addHistory: db.prepare('INSERT INTO history(user_id,track_id,track_json,played_at) VALUES(?,?,?,?)'),
  queue: db.prepare('SELECT track_json,position FROM queue_items WHERE user_id=? ORDER BY position'),
};

function loadEnv(){
  const file=path.join(__dirname,'.env');
  if(!fs.existsSync(file))return;
  for(const line of fs.readFileSync(file,'utf8').split(/\r?\n/)){const match=line.match(/^\s*([A-Za-z_][\w]*)\s*=\s*(.*?)\s*$/);if(!match||match[1] in process.env)continue;process.env[match[1]]=match[2].replace(/^(['"])(.*)\1$/,'$2');}
}
function json(res,status,data,headers={}){const body=JSON.stringify(data);res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Content-Length':Buffer.byteLength(body),'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers});res.end(body);}
function error(res,status,message){json(res,status,{error:message});}
function randomId(bytes=18){return crypto.randomBytes(bytes).toString('base64url');}
function tokenHash(token){return crypto.createHash('sha256').update(token).digest('hex');}
function safeEqual(a,b){const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&crypto.timingSafeEqual(x,y);}
function authUser(req){const header=req.headers.authorization||'';if(!header.startsWith('Bearer '))return null;const token=header.slice(7);const row=prepared.session.get(tokenHash(token));if(!row||row.expires_at<Date.now()){if(row)prepared.deleteSession.run(tokenHash(token));return null;}return{id:row.user_id,email:row.email,name:row.name,token};}
function tokenResponse(user){const token=randomId(32);prepared.insertSession.run(tokenHash(token),user.id,Date.now()+SESSION_DAYS*86400000);return{token,user:{id:user.id,email:user.email,name:user.name}};}
async function bodyJson(req,limit=MAX_BODY){const parts=[];let size=0;for await(const part of req){size+=part.length;if(size>limit)throw Object.assign(new Error('Request body is too large'),{status:413});parts.push(part);}if(!parts.length)return{};try{return JSON.parse(Buffer.concat(parts).toString('utf8'));}catch{throw Object.assign(new Error('Request body must be valid JSON'),{status:400});}}
function cleanName(value,max=80){return String(value||'').trim().replace(/\s+/g,' ').slice(0,max);}
function cleanTrack(input){if(!input||typeof input!=='object')return null;const id=cleanName(input.id||input.videoId,300);const title=cleanName(input.title,200);if(!id||!title)return null;return{id,title,artist:cleanName(input.artist||input.channel||'Unknown artist',160),thumbnail:String(input.thumbnail||'').slice(0,2000),duration:cleanName(input.duration,40),source:input.source==='local'?'local':'youtube',videoId:cleanName(input.videoId||input.id,120),mediaId:cleanName(input.mediaId,100),url:String(input.url||'').slice(0,2000)};}
function gate(req,res){const user=authUser(req);if(!user){error(res,401,'Sign in to use your library.');return null;}return user;}
function limitRequest(req,res){const now=Date.now(),key=req.socket.remoteAddress||'unknown';const prev=rateBuckets.get(key)||{start:now,count:0};if(now-prev.start>60000){prev.start=now;prev.count=0;}prev.count++;rateBuckets.set(key,prev);if(prev.count>240){error(res,429,'Too many requests. Try again in a minute.');return false;}return true;}
function limitSensitive(req,res,bucket,maximum){const now=Date.now(),key=`${bucket}:${req.socket.remoteAddress||'unknown'}`,prev=strictRateBuckets.get(key)||{start:now,count:0};if(now-prev.start>60000){prev.start=now;prev.count=0;}prev.count++;strictRateBuckets.set(key,prev);if(prev.count>maximum){error(res,429,'Too many requests. Try again in a minute.');return false;}return true;}
function videoResult(v){const id=String(v.videoId||v.video_id||'');if(!id)return null;return{id,videoId:id,title:String(v.title||'Untitled video'),artist:String(v.author?.name||v.author||v.channel||'Unknown artist'),thumbnail:String(v.thumbnail||v.image||''),duration:String(v.timestamp||v.duration||''),views:Number(v.views)||0,source:'youtube',url:`https://www.youtube.com/watch?v=${encodeURIComponent(id)}`};}
async function searchVideos(query,limit=24,pages=1){const pageCount=Math.max(1,Math.min(8,Number(pages)||1));const result=await ytSearch({query,pages:pageCount,gl:'KE',hl:'en'});return(result.videos||[]).slice(0,limit).map(videoResult).filter(Boolean);}
const searchQueryBatches=query=>[[query,`${query} official music video`],[`${query} live performance`,`${query} audio`,`${query} lyrics`],[`${query} remix`,`${query} cover`,`${query} acoustic`],[`${query} concert`,`${query} dance`,`${query} old songs`],[`${query} dance video`,`${query} slowed reverb`,`${query} lyrics official`],[`${query} full live`,`${query} acoustic live`,`${query} remastered`],[`${query} official audio`,`${query} top songs`,`${query} best songs`],[`${query} performance`,`${query} music video`,`${query} songs`]];
async function searchVideoCollection(query,batches){
  const key=query.toLocaleLowerCase(),now=Date.now();let entry=searchResultCache.get(key);
  if(!entry||entry.expiresAt<=now){entry={items:[],batchCount:0,expiresAt:now+10*60*1000};searchResultCache.set(key,entry);}
  const plans=searchQueryBatches(query);
  const target=Math.min(batches,plans.length),missing=plans.slice(entry.batchCount,target).flat();
  if(missing.length){const results=await Promise.all(missing.map(term=>searchVideos(term,24).catch(()=>[])));const unique=new Map(entry.items.map(item=>[item.id,item]));results.flat().forEach(item=>{if(!unique.has(item.id))unique.set(item.id,item)});entry.items=[...unique.values()];entry.batchCount=target;entry.expiresAt=Date.now()+10*60*1000;}
  if(searchResultCache.size>80){const oldest=searchResultCache.keys().next().value;searchResultCache.delete(oldest);}
  return entry;
}
function youtubeUrl(id){if(!/^[\w-]{11}$/.test(String(id)))throw Object.assign(new Error('Use a valid YouTube video ID.'),{status:400});return`https://www.youtube.com/watch?v=${id}`;}
function runYtDlp(args,timeout=120000){return new Promise((resolve,reject)=>{const full=['-m','yt_dlp','--ignore-config','--no-warnings',...args];const run=(command,rest,fallback=false)=>execFile(command,rest,{timeout,maxBuffer:64*1024*1024,windowsHide:true},(err,stdout,stderr)=>{if(err?.code==='ENOENT'&&!fallback){const other=command==='python'?'python3':'python';return run(other,rest,true);}if(err){err.stderr=String(stderr||'');return reject(err);}resolve({stdout:String(stdout),stderr:String(stderr||'')});});run(PYTHON_CMD,full);});}
function getVideoInfo(id){const url=youtubeUrl(id),cached=videoInfoCache.get(id);if(cached&&cached.expiresAt>Date.now())return Promise.resolve(cached.info);if(videoInfoPending.has(id))return videoInfoPending.get(id);const pending=runYtDlp(['--dump-single-json','--no-playlist','--ffmpeg-location',FFMPEG_PATH,url],90000).then(({stdout})=>{const info=JSON.parse(stdout);videoInfoCache.set(id,{info,expiresAt:Date.now()+4*60*1000});return info}).catch(e=>{const message=e.code==='ENOENT'?'yt-dlp is missing. Install it with python -m pip install -U yt-dlp.':'yt-dlp could not resolve this video. It may be private, region-restricted, or unavailable.';throw Object.assign(new Error(message),{status:e.code==='ENOENT'?503:502})}).finally(()=>videoInfoPending.delete(id));videoInfoPending.set(id,pending);return pending;}
function safeVideoTitle(value){return String(value||'music-video').normalize('NFKD').replace(/[^\p{L}\p{N} _-]/gu,'').trim().replace(/[ _]+/g,'_').slice(0,100)||'music-video';}
function streamFormats(info){return(info.formats||[]).filter(f=>f.url);}
function chooseCombined(info,height){return streamFormats(info).filter(f=>f.vcodec&&f.vcodec!=='none'&&f.acodec&&f.acodec!=='none'&&f.ext==='mp4'&&Number(f.height)>0&&Number(f.height)<=height).sort((a,b)=>Number(b.height)-Number(a.height)||Number(b.tbr||0)-Number(a.tbr||0))[0]||null;}
function chooseAdaptive(info,height){const formats=streamFormats(info),videos=formats.filter(f=>f.vcodec&&f.vcodec!=='none'&&Number(f.height)>0&&Number(f.height)<=height),mp4Videos=videos.filter(f=>f.ext==='mp4'),audios=formats.filter(f=>f.acodec&&f.acodec!=='none'&&(!f.vcodec||f.vcodec==='none')),m4aAudios=audios.filter(f=>f.ext==='m4a'),videoPool=mp4Videos.length?mp4Videos:videos,audioPool=m4aAudios.length?m4aAudios:audios;videoPool.sort((a,b)=>Number(b.height)-Number(a.height)||Number(b.tbr||0)-Number(a.tbr||0));audioPool.sort((a,b)=>Number(b.abr||b.tbr||0)-Number(a.abr||a.tbr||0));return videoPool[0]&&audioPool[0]?{video:videoPool[0],audio:audioPool[0]}:null;}
function availableVideoHeights(info){const max=Math.max(0,...streamFormats(info).filter(f=>f.vcodec&&f.vcodec!=='none').map(f=>Number(f.height)||0));return[144,240,360,480,720,1080,1440,2160].filter(h=>h<=max);}
function cleanFormat(input){const value=String(input||'video_720');if(/^audio_(128|192|320)$/.test(value))return value;const m=value.match(/^video_(144|240|360|480|720|1080|1440|2160)$/);if(!m)throw Object.assign(new Error('Choose a supported video quality.'),{status:400});return value;}
function spawnYtDlp(args,onStderr,onProcess){return new Promise((resolve,reject)=>{const launch=(command,fallback=false)=>{const processRef=spawn(command,['-m','yt_dlp','--ignore-config','--no-warnings','--no-playlist',...args],{windowsHide:true});onProcess(processRef);processRef.stderr.on('data',data=>onStderr(String(data)));let retrying=false;processRef.once('error',err=>{if(err.code==='ENOENT'&&!fallback){retrying=true;return launch(command==='python'?'python3':'python',true);}reject(err)});processRef.once('close',code=>{if(!retrying)resolve({code,process:processRef});});};launch(PYTHON_CMD);});}
async function downloadRemoteVideo(req,res,id,format){
  if(activeVideoDownloads>=3)return error(res,429,'Three downloads are already running. Try again shortly.');
  const videoUrl=youtubeUrl(id);format=cleanFormat(format);activeVideoDownloads++;
  const isAudio=format.startsWith('audio_'),height=Number(format.slice(6))||720;
  const output=path.join(DOWNLOAD_DIR,`${Date.now()}-${crypto.randomBytes(5).toString('hex')}.${isAudio?'mp3':'mp4'}`);
  let child=null,clientClosed=false,stderr='';const cleanup=()=>fs.promises.unlink(output).catch(()=>{});
  const kill=()=>child?.kill();
  req.once('aborted',()=>{clientClosed=true;kill();cleanup()});
  res.once('close',()=>{if(!res.writableEnded){clientClosed=true;kill();cleanup()}});
  try{
    const info=await getVideoInfo(id);if(clientClosed)return;if(!info?.title)throw Object.assign(new Error('Video details were unavailable.'),{status:502});
    const title=safeVideoTitle(info.title),outputName=isAudio?`${title}.mp3`:`${title}_${height}p.mp4`;
    const args=isAudio?['-f','bestaudio','--extract-audio','--audio-format','mp3','--audio-quality',format==='audio_320'?'320K':format==='audio_192'?'192K':'128K','--ffmpeg-location',FFMPEG_PATH,'-o',output,videoUrl]:['-f',`bestvideo[height<=${height}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=${height}]+bestaudio/best[height<=${height}]`,'--merge-output-format','mp4','--ffmpeg-location',FFMPEG_PATH,'-o',output,videoUrl];
    const timeout=setTimeout(()=>kill(),12*60*1000);timeout.unref();
    const result=await spawnYtDlp(args,data=>{stderr=(stderr+data).slice(-3000)},proc=>{child=proc});clearTimeout(timeout);
    if(clientClosed)return;
    if(result.code!==0||!fs.existsSync(output)){console.error('[yt-dlp download]',stderr);throw Object.assign(new Error(stderr.toLowerCase().includes('ffmpeg')?'FFmpeg could not process this format.':'yt-dlp could not download this video. It may be restricted or unavailable.'),{status:502});}
    const stat=fs.statSync(output);res.writeHead(200,{'Content-Type':isAudio?'audio/mpeg':'video/mp4','Content-Length':stat.size,'Content-Disposition':`attachment; filename="${outputName}"`,'X-Content-Type-Options':'nosniff','Cache-Control':'no-store'});
    await pipeline(fs.createReadStream(output),res);await cleanup();
  }catch(e){await cleanup();if(!res.headersSent)error(res,e.status||502,e.message||'Download failed.');}
  finally{activeVideoDownloads=Math.max(0,activeVideoDownloads-1);}
}
async function streamRemoteVideo(req,res,id,height){
  try{
    const info=await getVideoInfo(id),combined=chooseCombined(info,height);
    if(combined){res.writeHead(302,{'Location':combined.url,'Cache-Control':'no-store'});return res.end();}
    const streams=chooseAdaptive(info,height);if(!streams)return error(res,502,'No playable video and audio formats were found.');
    const args=['-hide_banner','-loglevel','error','-i',streams.video.url,'-i',streams.audio.url,'-map','0:v:0','-map','1:a:0','-c','copy','-movflags','+frag_keyframe+empty_moov+default_base_moof','-f','mp4','pipe:1'];
    const child=spawn(FFMPEG_PATH,args,{windowsHide:true});let stderr='';let started=false,disconnected=false;
    const stop=()=>{if(!res.writableEnded){disconnected=true;child.kill();}};
    res.once('close',stop);req.once('aborted',stop);child.stderr.on('data',data=>{stderr=(stderr+data).slice(-3000)});
    child.once('error',err=>{if(!res.headersSent)error(res,503,'FFmpeg is unavailable. Install the backend dependencies or set FFMPEG_PATH.');else res.destroy(err)});
    child.stdout.once('data',chunk=>{if(disconnected)return;started=true;res.writeHead(200,{'Content-Type':'video/mp4','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.write(chunk);child.stdout.pipe(res)});
    child.once('close',code=>{if(disconnected)return;if(code!==0){console.error('[ffmpeg playback]',stderr);if(!res.headersSent)error(res,502,'The video stream could not be prepared.');else res.destroy(new Error('Video stream failed.'));}else if(!started&&!res.headersSent)error(res,502,'The video stream returned no media data.');});
  }catch(e){if(!res.headersSent)error(res,e.status||502,e.message||'Could not resolve this video.')}
}
async function streamRemoteAudio(req,res,id){
  try{
    const info=await getVideoInfo(id),formats=streamFormats(info).filter(f=>f.acodec&&f.acodec!=='none'&&(!f.vcodec||f.vcodec==='none'));
    const m4a=formats.filter(f=>f.ext==='m4a'),audioPool=m4a.length?m4a:formats;
    audioPool.sort((a,b)=>Number(b.abr||b.tbr||0)-Number(a.abr||a.tbr||0));
    if(!audioPool[0])return error(res,502,'No playable audio stream was found.');
    res.writeHead(302,{'Location':audioPool[0].url,'Cache-Control':'no-store'});return res.end();
  }catch(e){return error(res,e.status||502,e.message||'Could not resolve this audio stream.');}
}
async function streamRemoteVideoOnly(req,res,id,height){
  try{
    const info=await getVideoInfo(id),formats=streamFormats(info).filter(f=>f.vcodec&&f.vcodec!=='none'&&Number(f.height)>0&&Number(f.height)<=height);
    const mp4=formats.filter(f=>f.ext==='mp4'),videoPool=mp4.length?mp4:formats;
    videoPool.sort((a,b)=>Number(b.height)-Number(a.height)||Number(b.tbr||0)-Number(a.tbr||0));
    if(!videoPool[0])return error(res,502,'No playable video stream was found.');
    res.writeHead(302,{'Location':videoPool[0].url,'Cache-Control':'no-store'});return res.end();
  }catch(e){return error(res,e.status||502,e.message||'Could not resolve this video stream.');}
}
async function refreshPopularVideos(){
  if(popularRefresh)return popularRefresh;
  popularRefresh=(async()=>{
    const year=new Date().getFullYear();
    const queries=[`Kenyan music videos ${year} official`,`East African music video hits ${year}`,`trending official music videos ${year}`];
    const results=await Promise.all(queries.map(q=>searchVideos(q,15).catch(()=>[])));
    const unique=new Map();for(const v of results.flat())if(!unique.has(v.id))unique.set(v.id,v);
    if(unique.size){popularCache.items=[...unique.values()].slice(0,60);try{fs.writeFileSync(path.join(DATA_DIR,'popular-cache.json'),JSON.stringify({items:popularCache.items,updatedAt:Date.now()}));}catch{}}
    popularCache.expiresAt=Date.now()+15*60*1000;
    return popularCache.items;
  })().finally(()=>{popularRefresh=null;});
  return popularRefresh;
}
async function popularVideos(){
  if(popularCache.expiresAt>Date.now())return popularCache.items;
  if(popularCache.items.length){refreshPopularVideos().catch(()=>{});return popularCache.items;}
  return refreshPopularVideos();
}
function mediaIndex(){const output=[];const walk=(dir)=>{for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const full=path.join(dir,entry.name);if(entry.isDirectory())walk(full);else if(MEDIA_EXTENSIONS.has(path.extname(entry.name).toLowerCase())){const relative=path.relative(MEDIA_DIR,full).split(path.sep).join('/');const id=crypto.createHash('sha256').update(relative).digest('hex').slice(0,24);const ext=path.extname(full).toLowerCase();output.push({id,title:path.basename(full,path.extname(full)).replace(/[._-]+/g,' '),artist:'Your library',duration:'',source:'local',mediaId:id,thumbnail:'',mime:MIME[ext]||'application/octet-stream',url:`/api/local-media/${id}`});}}};walk(MEDIA_DIR);return output.sort((a,b)=>a.title.localeCompare(b.title));}
function resolveMedia(id){const wanted=String(id);const walk=(dir)=>{for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const full=path.join(dir,entry.name);if(entry.isDirectory()){const found=walk(full);if(found)return found;}else if(MEDIA_EXTENSIONS.has(path.extname(full).toLowerCase())){const relative=path.relative(MEDIA_DIR,full).split(path.sep).join('/');if(crypto.createHash('sha256').update(relative).digest('hex').slice(0,24)===wanted)return full;}}return null;};return walk(MEDIA_DIR);}
function serveMedia(req,res,file,download=false){let stat;try{stat=fs.statSync(file);}catch{return error(res,404,'Media file not found.');}const ext=path.extname(file).toLowerCase(),mime=MIME[ext]||'application/octet-stream',range=req.headers.range;res.setHeader('Accept-Ranges','bytes');res.setHeader('Content-Type',mime);res.setHeader('X-Content-Type-Options','nosniff');if(download){const name=path.basename(file).replace(/[\r\n"\\]/g,'_');res.setHeader('Content-Disposition',`attachment; filename="${name}"`);}if(range){const match=range.match(/^bytes=(\d*)-(\d*)$/);if(!match)return error(res,416,'Invalid byte range.');let start=match[1]?Number(match[1]):0;let end=match[2]?Number(match[2]):stat.size-1;if(start>=stat.size||end<start)return error(res,416,'Byte range is outside the media file.');end=Math.min(end,stat.size-1);res.writeHead(206,{'Content-Range':`bytes ${start}-${end}/${stat.size}`,'Content-Length':end-start+1,'Cache-Control':'private, max-age=3600'});fs.createReadStream(file,{start,end}).pipe(res);}else{res.writeHead(200,{'Content-Length':stat.size,'Cache-Control':'private, max-age=3600'});fs.createReadStream(file).pipe(res);}}
function staticFile(res,file){const absolute=path.join(ROOT,file);fs.readFile(absolute,(err,data)=>{if(err)return error(res,404,'Not found.');res.writeHead(200,{'Content-Type':MIME[path.extname(absolute)]||'application/octet-stream','Content-Length':data.length,'X-Content-Type-Options':'nosniff','Referrer-Policy':'strict-origin-when-cross-origin','X-Frame-Options':'SAMEORIGIN','Cache-Control':'no-cache'});res.end(data);});}

async function route(req,res){if(!limitRequest(req,res))return;const url=new URL(req.url,`http://${req.headers.host||'localhost'}`);const p=url.pathname;if(req.method==='POST'&&(p==='/api/auth/register'||p==='/api/auth/login')&&!limitSensitive(req,res,'auth',12))return;if(req.method==='GET'&&p==='/api/music/search'&&!limitSensitive(req,res,'search',60))return;
  if(req.method==='GET'&&p==='/api/health')return json(res,200,{ok:true,service:'sonara',version:'1.0.0',mediaCount:mediaIndex().length,now:Date.now()});
  if(req.method==='POST'&&p==='/api/auth/register'){const body=await bodyJson(req);const email=String(body.email||'').trim().toLowerCase(),name=cleanName(body.name||email.split('@')[0],60),password=String(body.password||'');if(email.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))return error(res,400,'Enter a valid email address.');if(password.length<10||password.length>200)return error(res,400,'Password must be 10 to 200 characters.');const salt=crypto.randomBytes(16).toString('hex'),hash=crypto.scryptSync(password,salt,64).toString('hex'),id=randomId();try{prepared.insertUser.run(id,email,name,salt,hash,Date.now());return json(res,201,tokenResponse({id,email,name}));}catch(e){if(String(e.message).includes('UNIQUE'))return error(res,409,'An account with that email already exists.');throw e;}}
  if(req.method==='POST'&&p==='/api/auth/login'){const body=await bodyJson(req),email=String(body.email||'').trim().toLowerCase(),password=String(body.password||''),user=prepared.userByEmail.get(email);const salt=user?.password_salt||'00000000000000000000000000000000';const candidate=crypto.scryptSync(password,salt,64).toString('hex');if(!user||!safeEqual(candidate,user.password_hash))return error(res,401,'Email or password is incorrect.');return json(res,200,tokenResponse(user));}
  if(req.method==='GET'&&p==='/api/music/popular'){try{return json(res,200,{items:await popularVideos(),nextPage:null});}catch{return error(res,502,'Music search is temporarily unavailable.');}}
  if(req.method==='GET'&&p==='/api/music/search'){const q=cleanName(url.searchParams.get('q'),100);if(q.length<2)return error(res,400,'Search needs at least 2 characters.');const batches=Math.max(1,Math.min(8,Number.parseInt(url.searchParams.get('pages')||'2',10)||2));try{const result=await searchVideoCollection(q,batches);return json(res,200,{items:result.items,nextPage:batches<8?batches+1:null,pages:result.batchCount});}catch{return error(res,502,'Music search is temporarily unavailable.');}}
  const sharedMatch=p.match(/^\/api\/shared-playlists\/([\w-]+)$/);if(req.method==='GET'&&sharedMatch){const share=db.prepare('SELECT playlist_id,expires_at FROM playlist_shares WHERE token=?').get(sharedMatch[1]);if(!share||share.expires_at<Date.now()){if(share)db.prepare('DELETE FROM playlist_shares WHERE token=?').run(sharedMatch[1]);return error(res,404,'This playlist link has expired or was removed.');}const playlist=db.prepare('SELECT id,name FROM playlists WHERE id=?').get(share.playlist_id);if(!playlist)return error(res,404,'Playlist not found.');return json(res,200,{item:{...playlist,tracks:prepared.playlistTracks.all(playlist.id).map(t=>JSON.parse(t.track_json))}});}
  const videoMatch=p.match(/^\/api\/video\/([\w-]{11})(?:\/(formats|stream|download|audio|video))?$/);if(req.method==='GET'&&videoMatch){const id=videoMatch[1],action=videoMatch[2];if(action==='download')return downloadRemoteVideo(req,res,id,url.searchParams.get('format'));if(action==='audio')return streamRemoteAudio(req,res,id);if(action==='video'){const height=Number(url.searchParams.get('height')||720);if(![144,240,360,480,720,1080,1440,2160].includes(height))return error(res,400,'Choose a supported video quality.');return streamRemoteVideoOnly(req,res,id,height);}if(action==='stream'){const height=Number(url.searchParams.get('height')||720);if(![144,240,360,480,720,1080,1440,2160].includes(height))return error(res,400,'Choose a supported video quality.');return streamRemoteVideo(req,res,id,height);}try{const info=await getVideoInfo(id);return json(res,200,{id,videoId:id,title:info.title,artist:info.uploader||info.channel||'Unknown artist',thumbnail:info.thumbnail||'',duration:info.duration||0,formats:{video:availableVideoHeights(info),audio:[128,192,320]}});}catch(e){return error(res,e.status||502,e.message||'Could not resolve this video.');}}
  if(req.method==='GET'&&p==='/api/local-media')return json(res,200,{items:mediaIndex()});
  const mediaMatch=p.match(/^\/api\/local-media\/([a-f0-9]{24})(\/download)?$/);if(req.method==='GET'&&mediaMatch){const file=resolveMedia(mediaMatch[1]);if(!file)return error(res,404,'Local media was not found.');return serveMedia(req,res,file,Boolean(mediaMatch[2]));}
  if(req.method==='POST'&&p==='/api/local-media'){const user=gate(req,res);if(!user)return;const raw=req.headers['x-filename'];const fileName=path.basename(decodeURIComponent(String(raw||'upload'))).replace(/[^\p{L}\p{N} ._()-]/gu,'_').trim();const ext=path.extname(fileName).toLowerCase();if(!MEDIA_EXTENSIONS.has(ext))return error(res,415,'Use MP3, M4A, AAC, OGG, WAV, FLAC, MP4, MOV, or WebM files.');const target=path.join(MEDIA_DIR,`${Date.now()}-${randomId(6)}-${fileName}`);let bytes=0;const meter=new (require('node:stream').Transform)({transform(chunk,enc,cb){bytes+=chunk.length;if(bytes>MAX_UPLOAD)return cb(Object.assign(new Error('File exceeds 2 GB.'),{status:413}));cb(null,chunk);}});try{await pipeline(req,meter,fs.createWriteStream(target,{flags:'wx'}));return json(res,201,{item:mediaIndex().find(x=>x.title===path.basename(target,ext).replace(/^\d+-[^-]+-/,'').replace(/[._-]+/g,' '))||{title:fileName,source:'local'}});}catch(e){fs.promises.unlink(target).catch(()=>{});if(!res.headersSent)return error(res,e.status||400,e.message||'Upload failed.');return;}}
  if(req.method==='GET'&&p==='/api/me'){const user=gate(req,res);if(!user)return;return json(res,200,{user:{id:user.id,email:user.email,name:user.name}});}
  if(req.method==='POST'&&p==='/api/auth/logout'){const user=gate(req,res);if(!user)return;prepared.deleteSession.run(tokenHash(user.token));return json(res,200,{ok:true});}
  if(p.startsWith('/api/')){const user=gate(req,res);if(!user)return;
    if(req.method==='GET'&&p==='/api/library')return json(res,200,{items:prepared.favorites.all(user.id).map(x=>JSON.parse(x.track_json))});
    if(req.method==='POST'&&p==='/api/library'){const item=cleanTrack((await bodyJson(req)).track);if(!item)return error(res,400,'A valid track is required.');prepared.addFavorite.run(user.id,item.id,JSON.stringify(item),Date.now());return json(res,201,{item});}
    const favorite=p.match(/^\/api\/library\/([^/]+)$/);if(req.method==='DELETE'&&favorite){prepared.removeFavorite.run(user.id,decodeURIComponent(favorite[1]));return json(res,200,{ok:true});}
    if(req.method==='GET'&&p==='/api/playlists')return json(res,200,{items:prepared.playlists.all(user.id).map(x=>({...x,tracks:prepared.playlistTracks.all(x.id).map(t=>JSON.parse(t.track_json))}))});
    if(req.method==='POST'&&p==='/api/playlists'){const name=cleanName((await bodyJson(req)).name);if(!name)return error(res,400,'Playlist name is required.');const id=randomId(),now=Date.now();prepared.createPlaylist.run(id,user.id,name,now,now);return json(res,201,{item:{id,name,tracks:[],created_at:now,updated_at:now}});}
    const playlistShare=p.match(/^\/api\/playlists\/([^/]+)\/share$/);if(req.method==='POST'&&playlistShare){const id=decodeURIComponent(playlistShare[1]);if(!prepared.playlist.get(id,user.id))return error(res,404,'Playlist not found.');const token=randomId(16),now=Date.now();db.prepare('DELETE FROM playlist_shares WHERE playlist_id=?').run(id);db.prepare('INSERT INTO playlist_shares(token,playlist_id,user_id,created_at,expires_at) VALUES(?,?,?,?,?)').run(token,id,user.id,now,now+90*86400000);return json(res,201,{token,expiresAt:now+90*86400000});}
    const playlist=p.match(/^\/api\/playlists\/([^/]+)$/);if(playlist){const id=decodeURIComponent(playlist[1]),owned=prepared.playlist.get(id,user.id);if(!owned)return error(res,404,'Playlist not found.');if(req.method==='PATCH'){const name=cleanName((await bodyJson(req)).name);if(!name)return error(res,400,'Playlist name is required.');prepared.renamePlaylist.run(name,Date.now(),id,user.id);return json(res,200,{id,name});}if(req.method==='DELETE'){prepared.deletePlaylist.run(id,user.id);return json(res,200,{ok:true});}if(req.method==='GET')return json(res,200,{item:{...owned,tracks:prepared.playlistTracks.all(id).map(t=>JSON.parse(t.track_json))}});}
    const playlistTrack=p.match(/^\/api\/playlists\/([^/]+)\/tracks(?:\/([^/]+))?$/);if(playlistTrack){const id=decodeURIComponent(playlistTrack[1]);if(!prepared.playlist.get(id,user.id))return error(res,404,'Playlist not found.');if(req.method==='POST'){const item=cleanTrack((await bodyJson(req)).track);if(!item)return error(res,400,'A valid track is required.');const count=prepared.playlistTracks.all(id).length;prepared.addPlaylistTrack.run(id,item.id,JSON.stringify(item),count,Date.now());db.prepare('UPDATE playlists SET updated_at=? WHERE id=?').run(Date.now(),id);return json(res,201,{item});}if(req.method==='DELETE'&&playlistTrack[2]){prepared.removePlaylistTrack.run(id,decodeURIComponent(playlistTrack[2]));return json(res,200,{ok:true});}}
    if(req.method==='GET'&&p==='/api/queue')return json(res,200,{items:prepared.queue.all(user.id).map(x=>JSON.parse(x.track_json))});
    if(req.method==='PUT'&&p==='/api/queue'){const body=await bodyJson(req),items=Array.isArray(body.items)?body.items.slice(0,500).map(cleanTrack).filter(Boolean):[];db.exec('BEGIN');try{db.prepare('DELETE FROM queue_items WHERE user_id=?').run(user.id);const insert=db.prepare('INSERT INTO queue_items(user_id,position,track_id,track_json) VALUES(?,?,?,?)');items.forEach((t,i)=>insert.run(user.id,i,t.id,JSON.stringify(t)));db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}return json(res,200,{items});}
    if(req.method==='GET'&&p==='/api/history')return json(res,200,{items:prepared.history.all(user.id).map(x=>({...JSON.parse(x.track_json),playedAt:x.played_at}))});
    if(req.method==='POST'&&p==='/api/history'){const item=cleanTrack((await bodyJson(req)).track);if(!item)return error(res,400,'A valid track is required.');prepared.addHistory.run(user.id,item.id,JSON.stringify(item),Date.now());return json(res,201,{ok:true});}
    return error(res,404,'API route not found.');
  }
  if(req.method==='GET'&&p==='/')return staticFile(res,'index.html');
  if(req.method==='GET'&&['/index.html','/app.js','/style.css'].includes(p))return staticFile(res,p.slice(1));
  if(req.method==='GET'&&/^\/assets\/(icon|adaptive-icon|splash)\.png$/.test(p))return staticFile(res,p.slice(1));
  return error(res,404,'Not found.');
}

const server=http.createServer((req,res)=>{route(req,res).catch(err=>{console.error('[sonara]',err);if(!res.headersSent)error(res,err.status||500,err.status?err.message:'Something went wrong.');else res.destroy();});});
server.requestTimeout=5*60*1000;
server.listen(PORT,HOST,()=>console.log(`Sonara ready at http://${HOST}:${PORT}`));
process.on('SIGINT',()=>{server.close(()=>{db.close();process.exit(0);});});
process.on('SIGTERM',()=>{server.close(()=>{db.close();process.exit(0);});});
