import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, Alert, BackHandler, Image, Keyboard, KeyboardAvoidingView, Platform,
  Pressable, ScrollView, StatusBar, StyleSheet, Text, TextInput,
  View,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import { VideoView, useVideoPlayer } from 'expo-video';
import { setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import mobileAds, { AdsConsent, BannerAd, BannerAdSize, TestIds } from 'react-native-google-mobile-ads';
import { OneSignal } from 'react-native-onesignal';

const DEFAULT_API = 'http://192.168.150.152:5000';
const STORE = '@snapclone-mobile';
const C = { bg: '#0b0c10', panel: '#151720', panel2: '#1d202b', line: '#2a2d38', text: '#f4f4f6', muted: '#9295a3', purple: '#8c72ff', green: '#58d69a', red: '#ff6685' };

function normalizeTrack(t) {
  const id = String(t?.id || t?.videoId || t?.mediaId || '');
  return { ...t, id, videoId: String(t?.videoId || t?.id || ''), title: t?.title || 'Untitled video', artist: t?.artist || t?.channel || 'Unknown artist' };
}

function artistKey(value) {
  return String(value || '').toLowerCase().replace(/\s*[-|:]\s*(official|topic|vevo).*$/i, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function buildArtistAffinity(favorites, playlists, history) {
  const profile = new Map();
  const add = (name, amount) => {
    const clean = String(name || '').trim();
    if (!clean || /^unknown artist$/i.test(clean)) return;
    const key = artistKey(clean);
    const existing = [...profile.keys()].find(candidate => artistKey(candidate) === key);
    profile.set(existing || clean, (profile.get(existing || clean) || 0) + amount);
  };
  favorites.forEach(t => add(t.artist, 6));
  playlists.flatMap(p => p.tracks || []).forEach(t => add(t.artist, 1.5));
  const now = Date.now();
  history.forEach((t, i) => {
    const playedAt = Number(t.playedAt) || (now - i * 60_000);
    const ageDays = Math.max(0, (now - playedAt) / 86_400_000);
    add(t.artist, 2.5 * Math.exp(-ageDays / 21));
  });
  return profile;
}

function affinityFor(artist, profile) {
  const key = artistKey(artist);
  if (!key) return 0;
  let best = 0;
  for (const [name, score] of profile) {
    const candidate = artistKey(name);
    if (candidate === key) best = Math.max(best, score);
    else if (candidate.length > 2 && key.length > 2 && (candidate.includes(key) || key.includes(candidate))) best = Math.max(best, score * 0.72);
  }
  return best;
}

function rankRecommendations(candidates, profile, favorites, history, recentSearches = [], previouslyShown = []) {
  const unique = new Map();
  candidates.map(normalizeTrack).forEach(t => { if (t.id && !unique.has(t.id)) unique.set(t.id, t); });
  const favoriteIds = new Set(favorites.map(t => t.id));
  const recentIds = new Set(history.slice(0, 12).map(t => t.id));
  const shownPosition = new Map(previouslyShown.map((id, i) => [id, i]));
  const searchTerms = recentSearches.slice(0, 5).map(q => String(q).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w.length > 1));
  const pool = [...unique.values()].map((track, index) => {
    const artistScore = affinityFor(track.artist, profile);
    const viewsScore = Math.log10(Math.max(0, Number(track.views) || 0) + 1) * 0.15;
    const title = artistKey(track.title), artist = artistKey(track.artist);
    const searchScore = Math.max(0, ...searchTerms.map(words => words.filter(w => title.includes(w) || artist.includes(w)).length * 3));
    const seenAt = shownPosition.get(track.id);
    const seenPenalty = seenAt === undefined ? 0 : seenAt < 45 ? 16 : seenAt < 110 ? 7 : 2;
    return { track, index, base: artistScore * 2.5 + searchScore + viewsScore - seenPenalty - (favoriteIds.has(track.id) ? 2 : 0) - (recentIds.has(track.id) ? 1.5 : 0) + Math.random() * 7 };
  });
  const picked = [], artistCounts = new Map();
  while (pool.length) {
    let bestIndex = 0, bestScore = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const key = artistKey(pool[i].track.artist) || pool[i].track.id;
      const count = artistCounts.get(key) || 0;
      const adjusted = pool[i].base - count * 5;
      if (adjusted > bestScore) { bestScore = adjusted; bestIndex = i; }
    }
    const [choice] = pool.splice(bestIndex, 1);
    picked.push(choice.track);
    const key = artistKey(choice.track.artist) || choice.track.id;
    artistCounts.set(key, (artistCounts.get(key) || 0) + 1);
  }
  return picked;
}

function rankSearchResults(candidates, query) {
  const ignored = new Set(['official', 'music', 'video', 'videos', 'song', 'songs', 'the', 'and', 'feat', 'ft']);
  const terms = String(query || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(word => word.length > 1 && !ignored.has(word));
  return candidates.map((track, index) => {
    const title = artistKey(track.title), artist = artistKey(track.artist);
    const titleHits = terms.filter(word => title.includes(word)).length;
    const artistHits = terms.filter(word => artist.includes(word)).length;
    const popularity = Math.log10(Math.max(0, Number(track.views) || 0) + 1) * 0.32;
    return { track, index, score: titleHits * 4 + artistHits * 5 + (titleHits + artistHits === terms.length ? 3 : 0) + popularity };
  }).sort((a, b) => b.score - a.score || a.index - b.index).map(item => item.track);
}

function MusicApp() {
  const insets = useSafeAreaInsets();
  const [apiBase, setApiBase] = useState(DEFAULT_API);
  const [token, setToken] = useState('');
  const [user, setUser] = useState(null);
  const [tab, setTab] = useState('discover');
  const [tracks, setTracks] = useState([]);
  const [favorites, setFavorites] = useState([]);
  const [history, setHistory] = useState([]);
  const [recentSearches, setRecentSearches] = useState([]);
  const [playlists, setPlaylists] = useState([]);
  const [current, setCurrent] = useState(null);
  const [queue, setQueue] = useState([]);
  const [query, setQuery] = useState('');
  const [loadedSearchQuery, setLoadedSearchQuery] = useState('');
  const [nextSearchPage, setNextSearchPage] = useState(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [tasteReady, setTasteReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [mode, setMode] = useState('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [playlistName, setPlaylistName] = useState('');
  const [showPlaylistForm, setShowPlaylistForm] = useState(false);
  const [selectedPlaylist, setSelectedPlaylist] = useState(null);
  const [status, setStatus] = useState('Connecting…');
  const [playing, setPlaying] = useState(false);
  const [showServerSettings, setShowServerSettings] = useState(false);
  const [serverDraft, setServerDraft] = useState(DEFAULT_API);
  const [playerOpen, setPlayerOpen] = useState(false);
  const [videoLoading, setVideoLoading] = useState(false);
  const [videoError, setVideoError] = useState('');
  const [adsReady, setAdsReady] = useState(false);
  const finishHandled = useRef(false);
  const playbackHistory = useRef([]);
  const tasteHistory = useRef([]);
  const feedRequestId = useRef(0);
  const loadedSearchRef = useRef('');
  const recentSearchesRef = useRef([]);
  const seenRecommendationIds = useRef([]);
  const oneSignalAppId = Constants.expoConfig?.extra?.oneSignalAppId || '';
  const bannerUnitId = __DEV__ ? TestIds.BANNER : (Constants.expoConfig?.extra?.admobBannerId || '');

  const player = useVideoPlayer(null, p => { p.loop = false; p.muted = true; });
  const audioPlayer = useAudioPlayer(null, { updateInterval: 500 });
  const audioStatus = useAudioPlayerStatus(audioPlayer);

  const request = useCallback(async (path, options = {}) => {
    const headers = { ...(options.headers || {}) };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (options.body && typeof options.body === 'string') headers['Content-Type'] = 'application/json';
    let res;
    try { res = await fetch(`${apiBase.replace(/\/$/, '')}${path}`, { ...options, headers }); }
    catch { throw new Error(`Can't reach the server at ${apiBase}. Check the address and Wi-Fi.`); }
    const data = res.headers.get('content-type')?.includes('application/json') ? await res.json() : null;
    if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
    return data;
  }, [apiBase, token]);

  const loadLibrary = useCallback(async () => {
    if (!token) { setFavorites([]); setPlaylists([]); setQueue([]); return; }
    try {
      const [lib, pls, q, hist] = await Promise.all([request('/api/library'), request('/api/playlists'), request('/api/queue'), request('/api/history')]);
      setFavorites((lib.items || []).map(normalizeTrack));
      setPlaylists((pls.items || []).map(p => ({ ...p, tracks: (p.tracks || []).map(normalizeTrack) })));
      setQueue((q.items || []).map(normalizeTrack));
      const recent = (hist.items || []).map(normalizeTrack).map((t, i) => ({ ...t, playedAt: hist.items[i].playedAt }));
      tasteHistory.current = recent;
      setHistory(recent);
    } catch (e) { setError(e.message); }
  }, [request, token]);

  const artistAffinity = useMemo(() => buildArtistAffinity(favorites, playlists, tasteHistory.current), [favorites, playlists, history]);
  const favoriteArtistNames = useMemo(() => [...artistAffinity.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([artist]) => artist), [artistAffinity]);

  const loadFeed = useCallback(async (search = '') => {
    const requestId = ++feedRequestId.current;
    const searchText = search.trim();
    loadedSearchRef.current = searchText;
    setLoadedSearchQuery(searchText);
    if (searchText) {
      const nextSearches = [searchText, ...recentSearchesRef.current.filter(x => x.toLowerCase() !== searchText.toLowerCase())].slice(0, 12);
      recentSearchesRef.current = nextSearches;
      setRecentSearches(nextSearches);
      AsyncStorage.setItem(`${STORE}:searches`, JSON.stringify(nextSearches)).catch(() => {});
    }
    setBusy(true); setError(''); setNextSearchPage(null); setStatus(searchText ? 'Searching videos…' : 'Tuning your music…');
    try {
      const result = searchText
        ? await request(`/api/music/search?q=${encodeURIComponent(searchText)}&pages=2`)
        : await request('/api/music/popular');
      if (requestId !== feedRequestId.current) return;
      let items = (result.items || []).map(normalizeTrack);
      if (searchText) {
        items = rankSearchResults(items, searchText);
        setTracks(items);
        setNextSearchPage(result.nextPage);
        setStatus('Connected');
        return;
      }
      const currentAffinity = buildArtistAffinity(favorites, playlists, tasteHistory.current);
      const preferredArtists = [...currentAffinity.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([artist]) => artist);
      const exploreSeeds = ['new afrobeats music video', 'Kenyan pop music videos', 'Amapiano official videos', 'new R&B music videos', 'dancehall music videos', 'global gospel music videos', 'Latin pop music videos', 'K-pop official music videos'];
      const preferredQueries = [...recentSearchesRef.current.slice(0, 2), ...preferredArtists]
        .filter((value, index, list) => list.findIndex(x => x.toLowerCase() === value.toLowerCase()) === index).slice(0, 4);
      for (const seed of exploreSeeds.sort(() => Math.random() - 0.5)) {
        if (preferredQueries.length >= 4) break;
        if (!preferredQueries.some(q => q.toLowerCase() === seed.toLowerCase())) preferredQueries.push(seed);
      }
      const ranked = rankRecommendations(items, currentAffinity, favorites, tasteHistory.current, recentSearchesRef.current, seenRecommendationIds.current);
      setTracks(ranked);
      rememberRecommendations(ranked);
      setStatus('Connected');
      if (preferredQueries.length) {
        Promise.all(preferredQueries.map(value => request(`/api/music/search?q=${encodeURIComponent(value)}&pages=1`).then(x => x.items || []).catch(() => [])))
          .then(resultSets => {
            if (requestId !== feedRequestId.current) return;
            setTracks(previous => {
              const mixed = rankRecommendations([...resultSets.flat(), ...previous], currentAffinity, favorites, tasteHistory.current, recentSearchesRef.current, seenRecommendationIds.current);
              rememberRecommendations(mixed);
              return mixed;
            });
          });
      }
    } catch (e) { if (requestId === feedRequestId.current) { setTracks([]); setError(e.message); setStatus('Offline'); } }
    finally { if (requestId === feedRequestId.current) setBusy(false); }
  }, [favorites, playlists, request]);

  function rememberRecommendations(items) {
    const fresh = items.slice(0, 60).map(t => t.id).filter(Boolean);
    seenRecommendationIds.current = [...fresh, ...seenRecommendationIds.current.filter(id => !fresh.includes(id))].slice(0, 180);
    AsyncStorage.setItem(`${STORE}:shown`, JSON.stringify(seenRecommendationIds.current)).catch(() => {});
  }

  async function loadMoreSearch() {
    if (!nextSearchPage || loadingMore || !query.trim() || query.trim() !== loadedSearchQuery) return;
    const activeQuery = loadedSearchRef.current;
    setLoadingMore(true); setError('');
    try {
      const result = await request(`/api/music/search?q=${encodeURIComponent(activeQuery)}&pages=${nextSearchPage}`);
      if (activeQuery !== loadedSearchRef.current) return;
      setTracks(previous => {
        const merged = new Map(previous.map(t => [t.id, t]));
        (result.items || []).forEach(raw => { const t = normalizeTrack(raw); if (t.id) merged.set(t.id, t); });
        return rankSearchResults([...merged.values()], activeQuery);
      });
      setNextSearchPage(result.nextPage);
    } catch (e) { if (activeQuery === loadedSearchRef.current) setError(e.message); }
    finally { setLoadingMore(false); }
  }

  useEffect(() => {
    (async () => {
      const [savedBase, savedToken, savedHistory, savedSearches, savedShown] = await Promise.all([AsyncStorage.getItem(`${STORE}:api`), AsyncStorage.getItem(`${STORE}:token`), AsyncStorage.getItem(`${STORE}:history`), AsyncStorage.getItem(`${STORE}:searches`), AsyncStorage.getItem(`${STORE}:shown`)]);
      if (savedBase) setApiBase(savedBase);
      if (savedHistory) {
        try { const recent = JSON.parse(savedHistory).map(normalizeTrack); tasteHistory.current = recent; setHistory(recent); } catch {}
      }
      if (savedSearches) { try { const list = JSON.parse(savedSearches).filter(x => typeof x === 'string').slice(0, 12); recentSearchesRef.current = list; setRecentSearches(list); } catch {} }
      if (savedShown) { try { seenRecommendationIds.current = JSON.parse(savedShown).filter(x => typeof x === 'string').slice(0, 180); } catch {} }
      if (savedToken) setToken(savedToken);
      setTasteReady(true);
    })();
  }, []);

  useEffect(() => { if (tasteReady) loadFeed(); }, [loadFeed, tasteReady]);
  useEffect(() => { loadLibrary(); }, [loadLibrary]);
  useEffect(() => {
    setAudioModeAsync({ playsInSilentMode: true, shouldPlayInBackground: true, interruptionMode: 'doNotMix' }).catch(() => {});
  }, []);
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        await AdsConsent.gatherConsent();
        const { canRequestAds } = await AdsConsent.getConsentInfo();
        if (!canRequestAds) return;
        await mobileAds().initialize();
        if (active) setAdsReady(true);
      } catch (e) { console.warn('Sonara ads are unavailable until the native build is configured.', e?.message || e); }
    })();
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (!oneSignalAppId || Constants.appOwnership === 'expo') return;
    try { OneSignal.initialize(oneSignalAppId); }
    catch (e) { console.warn('OneSignal could not initialize.', e?.message || e); }
  }, [oneSignalAppId]);
  useEffect(() => {
    const sub = player.addListener('playingChange', e => setPlaying(e.isPlaying));
    return () => sub.remove();
  }, [player]);
  useEffect(() => {
    const sub = player.addListener('statusChange', e => {
      if (e.status === 'readyToPlay') { setVideoLoading(false); setVideoError(''); }
      if (e.status === 'error') { setVideoLoading(false); setVideoError(e.error?.message || 'This video could not be played. Try another video.'); }
    });
    return () => sub.remove();
  }, [player]);
  useEffect(() => {
    if (!audioStatus.didJustFinish) { finishHandled.current = false; return; }
    if (finishHandled.current) return;
    finishHandled.current = true;
    playNextTrack();
  }, [audioStatus.didJustFinish]);
  useEffect(() => { setPlaying(audioStatus.playing); }, [audioStatus.playing]);
  useEffect(() => {
    if (!playerOpen) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { closePlayer(); return true; });
    return () => sub.remove();
  }, [playerOpen]);

  const visibleTracks = useMemo(() => {
    if (tab === 'library') {
      if (selectedPlaylist) return playlists.find(p => p.id === selectedPlaylist)?.tracks || [];
      return favorites;
    }
    return tracks;
  }, [favorites, playlists, selectedPlaylist, tab, tracks]);
  async function playTrack(t) {
    if (current && current.id !== t.id) playbackHistory.current = [current, ...playbackHistory.current.filter(x => x.id !== current.id)].slice(0, 50);
    setCurrent(t);
    const recent = { ...t, playedAt: Date.now() };
    const nextHistory = [recent, ...tasteHistory.current].slice(0, 100);
    tasteHistory.current = nextHistory;
    setHistory(nextHistory);
    AsyncStorage.setItem(`${STORE}:history`, JSON.stringify(nextHistory)).catch(() => {});
    setPlayerOpen(true);
    const hasVideo = t.source !== 'local' || /^video\//.test(t.mime || '');
    setVideoLoading(hasVideo);
    setVideoError('');
    finishHandled.current = false;
    try {
      const videoUri = t.source === 'local'
        ? `${apiBase}/api/local-media/${encodeURIComponent(t.mediaId || t.id)}`
        : `${apiBase}/api/video/${encodeURIComponent(t.videoId || t.id)}/stream?height=720`;
      const audioUri = t.source === 'local'
        ? videoUri
        : `${apiBase}/api/video/${encodeURIComponent(t.videoId || t.id)}/audio`;
      audioPlayer.replace(audioUri);
      if (!(Platform.OS === 'android' && Constants.appOwnership === 'expo')) {
        audioPlayer.setActiveForLockScreen(true, { title: t.title, artist: t.artist, artworkUrl: t.thumbnail || undefined }, { showSeekBackward: true, showSeekForward: true });
      }
      audioPlayer.play();
      if (t.source !== 'local' || /^video\//.test(t.mime || '')) {
        await player.replaceAsync(videoUri);
        player.muted = true;
        player.play();
      } else { setVideoLoading(false); player.pause(); }
      if (token) request('/api/history', { method: 'POST', body: JSON.stringify({ track: t }) }).catch(() => {});
    } catch { setVideoLoading(false); setVideoError('The video could not start. Try another video.'); setError('Could not start playback. Check the server connection and try again.'); }
  }

  function closePlayer() {
    setPlayerOpen(false);
    player.pause();
  }

  async function enableNotifications() {
    if (!oneSignalAppId) { Alert.alert('Notifications are being set up', 'Add your OneSignal App ID and Firebase credentials to enable push notifications.'); return; }
    try {
      const granted = await OneSignal.Notifications.requestPermission(false);
      Alert.alert(granted ? 'Notifications enabled' : 'Notifications not enabled', granted ? 'We’ll let you know when there is something worth hearing.' : 'You can enable notifications later in your phone settings.');
    } catch { Alert.alert('Could not enable notifications', 'Please try again after installing the Sonara development build.'); }
  }

  async function retryVideo() {
    if (!current || (current.source === 'local' && !/^video\//.test(current.mime || ''))) return;
    setVideoLoading(true); setVideoError('');
    const uri = current.source === 'local'
      ? `${apiBase}/api/local-media/${encodeURIComponent(current.mediaId || current.id)}`
      : `${apiBase}/api/video/${encodeURIComponent(current.videoId || current.id)}/stream?height=720`;
    try { await player.replaceAsync(uri); player.muted = true; player.play(); }
    catch { setVideoLoading(false); setVideoError('The video could not start. Check your connection and try again.'); }
  }

  function togglePlayback() {
    if (playing) {
      audioPlayer.pause();
      player.pause();
    } else {
      audioPlayer.play();
      if (current && (current.source !== 'local' || /^video\//.test(current.mime || ''))) player.play();
    }
  }

  function persistQueue(nextQueue) {
    if (!token) return;
    request('/api/queue', { method: 'PUT', body: JSON.stringify({ items: nextQueue }) }).catch(() => {});
  }

  function queueNext(t) {
    const nextQueue = [t, ...queue.filter(x => x.id !== t.id)];
    setQueue(nextQueue); persistQueue(nextQueue);
  }

  function addToQueue(t) {
    if (queue.some(x => x.id === t.id)) return;
    const nextQueue = [...queue, t];
    setQueue(nextQueue); persistQueue(nextQueue);
  }

  function moveQueueItem(id, toFront) {
    const item = queue.find(x => x.id === id);
    if (!item) return;
    const rest = queue.filter(x => x.id !== id);
    const nextQueue = toFront ? [item, ...rest] : [...rest, item];
    setQueue(nextQueue); persistQueue(nextQueue);
  }

  function removeQueueItem(id) {
    const nextQueue = queue.filter(x => x.id !== id);
    setQueue(nextQueue); persistQueue(nextQueue);
  }

  function playNextTrack() {
    if (queue.length) {
      const [next, ...rest] = queue;
      setQueue(rest); persistQueue(rest); playTrack(next); return;
    }
    const index = visibleTracks.findIndex(t => t.id === current?.id);
    if (index >= 0 && visibleTracks.length > 1) playTrack(visibleTracks[(index + 1) % visibleTracks.length]);
  }

  function playPreviousTrack() {
    if (audioStatus.currentTime > 3) { audioPlayer.seekTo(0); return; }
    const previous = playbackHistory.current[0];
    if (previous) {
      playbackHistory.current = playbackHistory.current.slice(1);
      if (current) { const nextQueue = [current, ...queue.filter(x => x.id !== current.id)]; setQueue(nextQueue); persistQueue(nextQueue); }
      playTrack(previous);
    } else audioPlayer.seekTo(0);
  }

  async function authenticate() {
    Keyboard.dismiss(); setBusy(true); setError('');
    try {
      const result = await request(`/api/auth/${mode === 'register' ? 'register' : 'login'}`, {
        method: 'POST', body: JSON.stringify({ email: email.trim(), password, ...(mode === 'register' ? { name: name.trim() } : {}) }),
      });
      await AsyncStorage.setItem(`${STORE}:token`, result.token);
      setToken(result.token); setUser(result.user); setPassword(''); setTab('library');
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function toggleFavorite(t) {
    if (!token) { setTab('account'); setError('Sign in first to save videos to your library.'); return; }
    try {
      const exists = favorites.some(x => x.id === t.id);
      if (exists) await request(`/api/library/${encodeURIComponent(t.id)}`, { method: 'DELETE' });
      else await request('/api/library', { method: 'POST', body: JSON.stringify({ track: t }) });
      await loadLibrary();
    } catch (e) { setError(e.message); }
  }

  async function createPlaylist() {
    if (!token) { setTab('account'); setError('Sign in first to create playlists.'); return; }
    if (!playlistName.trim()) return;
    try { await request('/api/playlists', { method: 'POST', body: JSON.stringify({ name: playlistName.trim() }) }); setPlaylistName(''); setShowPlaylistForm(false); await loadLibrary(); }
    catch (e) { setError(e.message); }
  }

  async function addToPlaylist(p, t) {
    try { await request(`/api/playlists/${encodeURIComponent(p.id)}/tracks`, { method: 'POST', body: JSON.stringify({ track: t }) }); await loadLibrary(); Alert.alert('Added', `Added to ${p.name}`); }
    catch (e) { setError(e.message); }
  }

  function promptPlaylist(t) {
    if (!token) { setTab('account'); setError('Sign in first to use playlists.'); return; }
    if (!playlists.length) { setShowPlaylistForm(true); setTab('library'); return; }
    Alert.alert('Add to playlist', 'Choose a playlist', [...playlists.map(p => ({ text: p.name, onPress: () => addToPlaylist(p, t) })), { text: 'Cancel', style: 'cancel' }]);
  }

  async function updateServerAddress() {
    setServerDraft(apiBase);
    setShowServerSettings(true);
  }

  async function saveServerAddress() {
    const clean = serverDraft.trim().replace(/\/$/, '');
    if (!/^https?:\/\//.test(clean)) { setError('Server address must start with http:// or https://'); return; }
    setApiBase(clean);
    await AsyncStorage.setItem(`${STORE}:api`, clean);
    setShowServerSettings(false);
    setError('');
  }

  async function signOut() {
    try { await request('/api/auth/logout', { method: 'POST' }); } catch {}
    await AsyncStorage.removeItem(`${STORE}:token`); await AsyncStorage.removeItem(`${STORE}:history`); tasteHistory.current = []; setHistory([]); setToken(''); setUser(null); setFavorites([]); setPlaylists([]); setQueue([]); persistQueue([]); setTab('discover');
  }

  return (
    <SafeAreaView style={s.safe} edges={['top', 'left', 'right']}>
      <StatusBar barStyle="light-content" backgroundColor={C.bg} />
      <View style={s.header}>
        {playerOpen ? <Pressable style={s.backButton} onPress={closePlayer}><Text style={s.backGlyph}>‹</Text><Text style={s.backLabel}>Back</Text></Pressable> : <View><Text style={s.brand}>sonara<Text style={s.brandDot}>.</Text></Text><Text style={s.subtitle}>MUSIC THAT FEELS LIKE YOU</Text></View>}
        {playerOpen ? <View style={s.nowPlayingBadge}><View style={[s.dot, { backgroundColor: C.green }]} /><Text style={s.nowPlayingBadgeText}>NOW PLAYING</Text></View> : <Pressable style={s.status} onPress={updateServerAddress}><View style={[s.dot, status === 'Connected' && { backgroundColor: C.green }, status === 'Offline' && { backgroundColor: C.red }]} /><Text style={s.statusText}>{status}</Text><Text style={s.settingsIcon}>⚙</Text></Pressable>}
      </View>

      {current && !playerOpen && <Pressable style={s.miniPlayer} onPress={() => setPlayerOpen(true)}>
        {current.thumbnail ? <Image source={{ uri: current.thumbnail }} style={s.miniArt} /> : <View style={[s.miniArt, s.artFallback]}><Text style={s.miniMusic}>♫</Text></View>}
        <View style={{ flex: 1 }}><Text numberOfLines={1} style={s.nowTitle}>{current.title}</Text><Text numberOfLines={1} style={s.muted}>{current.artist}</Text></View>
        <Pressable style={s.miniControl} onPress={e => { e.stopPropagation(); togglePlayback(); }}><Text style={s.playGlyph}>{playing ? 'Ⅱ' : '▶'}</Text></Pressable>
      </Pressable>}

      {tab === 'discover' && !playerOpen && <View style={s.searchWrap}>
        <TextInput style={s.searchInput} value={query} onChangeText={setQuery} onSubmitEditing={() => loadFeed(query)} placeholder="Search songs, artists, videos" placeholderTextColor={C.muted} returnKeyType="search" />
        <Pressable style={s.searchButton} onPress={() => loadFeed(query)}><Text style={s.searchGlyph}>⌕</Text></Pressable>
      </View>}

      {error ? <Pressable onPress={() => setError('')} style={s.errorBox}><Text style={s.errorText}>{error}  ×</Text></Pressable> : null}

      {showServerSettings && <View style={s.modalBackdrop}><View style={s.modalCard}><Text style={s.accountTitle}>Connect to your computer</Text><Text style={[s.muted, { marginTop: 5 }]}>Enter its Wi-Fi address and port 5000.</Text><TextInput style={s.formInput} value={serverDraft} onChangeText={setServerDraft} autoCapitalize="none" keyboardType="url" placeholder="http://192.168.1.25:5000" placeholderTextColor={C.muted} /><View style={s.modalActions}><Pressable style={s.outlineButton} onPress={() => setShowServerSettings(false)}><Text style={s.linkText}>Cancel</Text></Pressable><Pressable style={s.smallPrimary} onPress={saveServerAddress}><Text style={s.buttonText}>Save address</Text></Pressable></View></View></View>}

      {playerOpen && current ? <ScrollView style={s.playerScroll} contentContainerStyle={s.playerScreen}>
        <View style={s.playerMedia}>
          {current.thumbnail ? <Image source={{ uri: current.thumbnail }} style={s.playerPoster} /> : null}
          {current.source !== 'local' || /^video\//.test(current.mime || '')
            ? <VideoView player={player} style={s.playerVideo} contentFit="cover" nativeControls={false} fullscreenOptions={{ enable: true }} />
            : current.thumbnail ? <Image source={{ uri: current.thumbnail }} style={s.playerArtwork} /> : <View style={[s.playerArtwork, s.artFallback]}><Text style={s.playerMusic}>♫</Text></View>}
          <View style={s.videoTag}><View style={s.videoTagDot} /><Text style={s.videoTagText}>SONARA SESSION</Text></View>
          {videoLoading && <View style={s.videoMessage}><ActivityIndicator color={C.purple} /><Text style={s.videoMessageText}>Starting video…</Text></View>}
          {!!videoError && <View style={s.videoMessage}><Text style={s.videoMessageText}>{videoError}</Text><Pressable style={s.videoRetry} onPress={retryVideo}><Text style={s.videoRetryText}>Try again</Text></Pressable></View>}
        </View>
        <View style={s.trackInfoRow}><View style={s.trackInfoCopy}><Text style={s.playerEyebrow}>NOW PLAYING</Text><Text numberOfLines={2} style={s.playerTitle}>{current.title}</Text><Text style={s.playerArtist}>{current.artist}</Text></View><Pressable accessibilityLabel="Save this song" style={s.playerFavorite} onPress={() => toggleFavorite(current)}><Text style={[s.playerFavoriteGlyph, favorites.some(t => t.id === current.id) && { color: C.red }]}>{favorites.some(t => t.id === current.id) ? '♥' : '♡'}</Text></Pressable></View>
        <View style={s.progressLabels}><Text style={s.progressTime}>{formatTime(audioStatus.currentTime)}</Text><Text style={s.progressTime}>{formatTime(audioStatus.duration)}</Text></View>
        <View style={s.progressTrack}><View style={[s.progressFill, { width: `${audioStatus.duration ? Math.min(100, audioStatus.currentTime / audioStatus.duration * 100) : 0}%` }]} /></View>
        <View style={s.transportControls}>
          <Pressable style={s.transportSide} onPress={playPreviousTrack}><Text style={s.transportSideGlyph}>|‹</Text></Pressable>
          <Pressable style={s.seekButton} onPress={() => audioPlayer.seekTo(Math.max(0, audioStatus.currentTime - 10))}><Text style={s.seekGlyph}>−10</Text></Pressable>
          <Pressable style={s.transportPlay} onPress={togglePlayback}><Text style={s.transportPlayGlyph}>{playing ? 'Ⅱ' : '▶'}</Text></Pressable>
          <Pressable style={s.seekButton} onPress={() => audioPlayer.seekTo(Math.min(audioStatus.duration || 0, audioStatus.currentTime + 30))}><Text style={s.seekGlyph}>+30</Text></Pressable>
          <Pressable style={s.transportSide} onPress={playNextTrack}><Text style={s.transportSideGlyph}>›|</Text></Pressable>
        </View>
        {adsReady && bannerUnitId ? <View style={s.adCard}><Text style={s.adLabel}>SPONSORED</Text><BannerAd unitId={bannerUnitId} size={BannerAdSize.LARGE_ANCHORED_ADAPTIVE_BANNER} onAdFailedToLoad={e => console.warn('Ad banner failed to load:', e.message)} /></View> : null}
        <View style={s.queueHeading}><View><Text style={s.sectionTitle}>UP NEXT</Text><Text style={s.queueCount}>{queue.length ? `${queue.length} ${queue.length === 1 ? 'song' : 'songs'}` : 'A little more of your taste'}</Text></View>{queue.length ? <Pressable onPress={() => { setQueue([]); persistQueue([]); }}><Text style={s.linkText}>Clear</Text></Pressable> : null}</View>
        {queue.length ? queue.map((t, i) => <View key={t.id} style={s.queueRow}>
          <Text style={s.queuePosition}>{String(i + 1).padStart(2, '0')}</Text>
          {t.thumbnail ? <Image source={{ uri: t.thumbnail }} style={s.queueArt} /> : <View style={[s.queueArt, s.artFallback]}><Text style={s.playlistIcon}>♫</Text></View>}
          <Pressable style={s.queueTrack} onPress={() => { removeQueueItem(t.id); playTrack(t); }}><Text numberOfLines={1} style={s.queueTrackTitle}>{t.title}</Text><Text numberOfLines={1} style={s.muted}>{t.artist}</Text></Pressable>
          <Pressable style={s.queueAction} onPress={() => moveQueueItem(t.id, true)}><Text style={s.queueActionText}>↑ Front</Text></Pressable>
          <Pressable style={s.queueAction} onPress={() => moveQueueItem(t.id, false)}><Text style={s.queueActionText}>↓ Back</Text></Pressable>
          <Pressable style={s.queueRemove} onPress={() => removeQueueItem(t.id)}><Text style={s.muted}>×</Text></Pressable>
        </View>) : tracks.filter(t => t.id !== current.id).slice(0, 3).map(t => <Pressable key={t.id} style={s.suggestionRow} onPress={() => addToQueue(t)}>
          {t.thumbnail ? <Image source={{ uri: t.thumbnail }} style={s.queueArt} /> : <View style={[s.queueArt, s.artFallback]}><Text style={s.playlistIcon}>♫</Text></View>}
          <View style={s.queueTrack}><Text numberOfLines={1} style={s.queueTrackTitle}>{t.title}</Text><Text numberOfLines={1} style={s.muted}>{t.artist}</Text></View>
          <Text style={s.suggestionAdd}>＋ Queue</Text>
        </Pressable>)}
      </ScrollView> : <>
      <View style={s.headingRow}>
        <View><Text style={s.eyebrow}>{tab === 'discover' ? 'YOUR NEXT FAVORITE' : tab === 'library' ? 'YOUR COLLECTION' : 'ACCOUNT'}</Text><Text style={s.heading}>{tab === 'discover' ? (query ? 'Search results' : 'Discover') : tab === 'library' ? (selectedPlaylist ? playlists.find(p => p.id === selectedPlaylist)?.name || 'Playlist' : 'Your library') : (user?.name || 'Sign in')}</Text></View>
        {tab === 'library' && selectedPlaylist ? <Pressable onPress={() => setSelectedPlaylist(null)}><Text style={s.linkText}>← Library</Text></Pressable> : null}
      </View>

      {tab === 'discover' || tab === 'library' ? <ScrollView contentContainerStyle={s.list} keyboardShouldPersistTaps="handled">
        {tab === 'discover' && favoriteArtistNames.length > 0 && !query.trim() && <View style={s.recommendationCard}><Text style={s.sectionTitle}>TUNED TO YOUR TASTE</Text><Text style={s.recommendationText}>More from {favoriteArtistNames.join(', ')}</Text><Text style={s.recommendationSub}>Favorites and recent listening help shape what you see here.</Text></View>}
        {tab === 'discover' && recentSearches.length > 0 && !query.trim() && <View style={s.recentSearchSection}><Text style={s.sectionTitle}>RECENT SEARCHES</Text><ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.recentSearchList}>{recentSearches.slice(0, 6).map(term => <Pressable key={term} style={s.recentSearchChip} onPress={() => { setQuery(term); loadFeed(term); }}><Text numberOfLines={1} style={s.recentSearchText}>{term}</Text></Pressable>)}</ScrollView></View>}
        {tab === 'library' && !selectedPlaylist && <>
          <View style={s.sectionRow}><Text style={s.sectionTitle}>PLAYLISTS</Text><Pressable onPress={() => setShowPlaylistForm(v => !v)}><Text style={s.linkText}>＋ New</Text></Pressable></View>
          {showPlaylistForm && <View style={s.createRow}><TextInput style={s.formInput} value={playlistName} onChangeText={setPlaylistName} placeholder="Playlist name" placeholderTextColor={C.muted} /><Pressable style={s.smallPrimary} onPress={createPlaylist}><Text style={s.buttonText}>Create</Text></Pressable></View>}
          {playlists.length ? <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.playlistStrip}>{playlists.map(p => <Pressable key={p.id} onPress={() => setSelectedPlaylist(p.id)} style={s.playlistPill}><Text style={s.playlistIcon}>♫</Text><Text style={s.playlistName} numberOfLines={1}>{p.name}</Text></Pressable>)}</ScrollView> : <Text style={s.emptyHint}>Create a playlist to collect videos.</Text>}
          <Text style={[s.sectionTitle, { marginTop: 20 }]}>SAVED VIDEOS</Text>
        </>}
        {busy && !visibleTracks.length ? <ActivityIndicator size="large" color={C.purple} style={{ marginTop: 50 }} /> : visibleTracks.length ? visibleTracks.map(t => <TrackCard key={t.id} track={t} favorite={favorites.some(x => x.id === t.id)} onPlay={() => playTrack(t)} onFavorite={() => toggleFavorite(t)} onPlaylist={() => promptPlaylist(t)} onNext={() => queueNext(t)} onQueue={() => addToQueue(t)} />) : <View style={s.empty}><Text style={s.emptyIcon}>{tab === 'library' ? '♡' : '♫'}</Text><Text style={s.emptyTitle}>{tab === 'library' ? 'Your library is waiting' : 'No videos found'}</Text><Text style={s.muted}>{tab === 'library' ? 'Tap the heart on a video to save it here.' : (error || 'Try another search or check the server connection.')}</Text>{tab === 'discover' && <Pressable style={s.outlineButton} onPress={() => loadFeed(query)}><Text style={s.linkText}>Try again</Text></Pressable>}</View>}
        {tab === 'discover' && query.trim() === loadedSearchQuery && query.trim() && nextSearchPage && <Pressable style={[s.loadMore, loadingMore && { opacity: 0.6 }]} onPress={loadMoreSearch} disabled={loadingMore}><Text style={s.loadMoreText}>{loadingMore ? 'Finding more videos…' : 'Load more search results'}</Text></Pressable>}
      </ScrollView> : tab === 'account' ? <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={s.accountContent} keyboardShouldPersistTaps="handled">
          <View style={s.accountCard}>
            <Text style={s.accountIcon}>{user?.name?.[0]?.toUpperCase() || '♫'}</Text>
            <Text style={s.accountTitle}>{user ? `Welcome, ${user.name}` : mode === 'login' ? 'Welcome back' : 'Create your account'}</Text>
            <Text style={s.muted}>{user ? user.email : 'Sign in to sync your saved videos and playlists.'}</Text>
            {!user ? <>
              {mode === 'register' && <TextInput style={s.formInput} value={name} onChangeText={setName} placeholder="Your name" placeholderTextColor={C.muted} autoCapitalize="words" />}
              <TextInput style={s.formInput} value={email} onChangeText={setEmail} placeholder="Email address" placeholderTextColor={C.muted} keyboardType="email-address" autoCapitalize="none" />
              <TextInput style={s.formInput} value={password} onChangeText={setPassword} placeholder="Password (10+ characters)" placeholderTextColor={C.muted} secureTextEntry />
              <Pressable style={s.primaryButton} onPress={authenticate} disabled={busy}><Text style={s.buttonText}>{busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}</Text></Pressable>
              <Pressable onPress={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(''); }}><Text style={s.linkText}>{mode === 'login' ? 'New here? Create account' : 'Already have an account? Sign in'}</Text></Pressable>
            </> : <Pressable style={s.outlineButton} onPress={signOut}><Text style={s.linkText}>Sign out</Text></Pressable>}
          </View>
          <Pressable style={s.notificationCard} onPress={enableNotifications}><View style={s.notificationIcon}><Text style={s.notificationIconGlyph}>♢</Text></View><View style={{ flex: 1 }}><Text style={s.sectionTitle}>NEW MUSIC, ON YOUR TERMS</Text><Text style={s.notificationCopy}>Get a heads-up when artists you follow release something new.</Text></View><Text style={s.notificationArrow}>›</Text></Pressable>
          <Pressable style={s.serverCard} onPress={updateServerAddress}><Text style={s.sectionTitle}>SERVER CONNECTION</Text><Text style={s.muted}>This phone connects to</Text><Text style={s.serverUrl}>{apiBase}</Text><Text style={s.linkText}>Tap here to change address</Text></Pressable>
        </ScrollView>
      </KeyboardAvoidingView> : null}
      </>}

      {!playerOpen && <View style={[s.tabs, { paddingBottom: Math.max(insets.bottom, 12) }]}>
        <Tab label="Discover" icon="⌕" active={tab === 'discover'} onPress={() => { setTab('discover'); setSelectedPlaylist(null); }} />
        <Tab label="Library" icon="♫" active={tab === 'library'} onPress={() => { setTab('library'); setSelectedPlaylist(null); loadLibrary(); }} />
        <Tab label="Account" icon="◉" active={tab === 'account'} onPress={() => setTab('account')} />
      </View>}
    </SafeAreaView>
  );
}

export default function App() {
  return <SafeAreaProvider><MusicApp /></SafeAreaProvider>;
}

function formatTime(seconds = 0) {
  const n = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
}

function TrackCard({ track, favorite, onPlay, onFavorite, onPlaylist, onNext, onQueue }) {
  return <View style={s.trackCard}>
    <Pressable onPress={onPlay} style={s.artWrap}>
      {track.thumbnail ? <Image source={{ uri: track.thumbnail }} style={s.art} /> : <View style={[s.art, s.artFallback]}><Text style={s.artMusic}>♫</Text></View>}
      <View style={s.artPlay}><Text style={s.artPlayText}>▶</Text></View>
      {!!track.duration && <View style={s.duration}><Text style={s.durationText}>{track.duration}</Text></View>}
    </Pressable>
    <View style={s.trackBottom}>
      <Pressable style={{ flex: 1 }} onPress={onPlay}><Text numberOfLines={1} style={s.trackTitle}>{track.title}</Text><Text numberOfLines={1} style={s.trackArtist}>{track.artist}</Text></Pressable>
      <Pressable onPress={onFavorite} style={s.iconButton}><Text style={[s.heart, favorite && { color: C.red }]}>{favorite ? '♥' : '♡'}</Text></Pressable>
      <Pressable onPress={onPlaylist} style={s.iconButton}><Text style={s.plus}>＋</Text></Pressable>
      <Pressable onPress={onNext} style={s.queueChip}><Text style={s.queueChipText}>⏭ Next</Text></Pressable>
      <Pressable onPress={onQueue} style={s.queueChip}><Text style={s.queueChipText}>☷ Queue</Text></Pressable>
    </View>
  </View>;
}

function Tab({ label, icon, active, onPress }) {
  return <Pressable onPress={onPress} style={s.tab}><Text style={[s.tabIcon, active && { color: C.purple }]}>{icon}</Text><Text style={[s.tabLabel, active && { color: C.text }]}>{label}</Text></Pressable>;
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  header: { paddingHorizontal: 20, paddingTop: 7, paddingBottom: 17, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  brand: { color: C.text, fontSize: 27, letterSpacing: -1.4, fontWeight: '900' }, brandDot: { color: C.purple },
  subtitle: { color: C.muted, fontSize: 8, letterSpacing: 2.1, marginTop: 1, fontWeight: '700' },
  status: { flexDirection: 'row', alignItems: 'center', backgroundColor: C.panel, borderRadius: 20, paddingHorizontal: 10, paddingVertical: 8, gap: 6 },
  dot: { width: 7, height: 7, borderRadius: 5, backgroundColor: '#d8ab59' }, statusText: { color: C.muted, fontSize: 10 }, settingsIcon: { color: C.muted, marginLeft: 4, fontSize: 13 },
  miniPlayer: { marginHorizontal: 14, marginBottom: 9, padding: 8, backgroundColor: C.panel, borderRadius: 13, borderWidth: 1, borderColor: C.line, flexDirection: 'row', alignItems: 'center', gap: 10 }, miniArt: { width: 42, height: 42, borderRadius: 8, backgroundColor: C.panel2 }, miniMusic: { color: C.purple, fontSize: 18 }, miniControl: { width: 38, height: 38, borderRadius: 20, backgroundColor: C.purple, alignItems: 'center', justifyContent: 'center' }, nowTitle: { color: C.text, fontWeight: '700', fontSize: 13 }, muted: { color: C.muted, fontSize: 12, lineHeight: 18 }, playGlyph: { color: '#fff', fontWeight: '900' },
  backButton: { flexDirection: 'row', alignItems: 'center', paddingVertical: 4, paddingRight: 14 }, backGlyph: { color: C.text, fontSize: 32, lineHeight: 34, marginRight: 4 }, backLabel: { color: C.text, fontSize: 16, fontWeight: '700' },
  searchWrap: { marginHorizontal: 18, flexDirection: 'row', alignItems: 'center', borderRadius: 12, backgroundColor: C.panel, borderColor: C.line, borderWidth: 1, paddingLeft: 13, paddingRight: 5, height: 47, marginBottom: 20 }, searchInput: { flex: 1, color: C.text, fontSize: 14 }, searchButton: { width: 38, height: 38, borderRadius: 10, backgroundColor: C.purple, justifyContent: 'center', alignItems: 'center' }, searchGlyph: { color: '#fff', fontSize: 25, marginTop: -5 },
  errorBox: { marginHorizontal: 18, backgroundColor: '#361e2a', padding: 10, borderRadius: 10, marginBottom: 10 }, errorText: { color: '#ffb1c2', fontSize: 12 },
  headingRow: { paddingHorizontal: 20, marginBottom: 14, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' }, eyebrow: { color: C.purple, fontSize: 9, fontWeight: '800', letterSpacing: 1.8 }, heading: { color: C.text, fontWeight: '800', fontSize: 23, marginTop: 3 }, linkText: { color: C.purple, fontWeight: '700', fontSize: 12 },
  list: { paddingHorizontal: 17, paddingBottom: 22 }, trackCard: { backgroundColor: C.panel, borderRadius: 14, overflow: 'hidden', marginBottom: 14, borderWidth: 1, borderColor: C.line }, artWrap: { width: '100%', height: 188, backgroundColor: '#20222e' }, art: { width: '100%', height: '100%' }, artFallback: { alignItems: 'center', justifyContent: 'center', backgroundColor: '#252136' }, artMusic: { color: C.purple, fontSize: 45 }, artPlay: { position: 'absolute', left: 13, bottom: 12, width: 35, height: 35, borderRadius: 19, backgroundColor: C.purple, alignItems: 'center', justifyContent: 'center' }, artPlayText: { color: '#fff', fontSize: 13, marginLeft: 2 }, duration: { position: 'absolute', bottom: 13, right: 11, backgroundColor: '#08090cdd', borderRadius: 5, paddingHorizontal: 6, paddingVertical: 3 }, durationText: { color: '#fff', fontSize: 9 },
  trackBottom: { paddingHorizontal: 10, paddingVertical: 11, flexDirection: 'row', alignItems: 'center', gap: 5 }, trackTitle: { color: C.text, fontSize: 14, fontWeight: '700' }, trackArtist: { color: C.muted, fontSize: 11, marginTop: 4 }, iconButton: { width: 28, height: 34, alignItems: 'center', justifyContent: 'center' }, heart: { color: C.muted, fontSize: 21 }, plus: { color: C.muted, fontSize: 21 }, queueChip: { backgroundColor: C.panel2, borderRadius: 8, paddingHorizontal: 7, paddingVertical: 8 }, queueChipText: { color: C.text, fontSize: 10, fontWeight: '700' },
  sectionRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 9 }, sectionTitle: { color: C.muted, fontSize: 10, letterSpacing: 1.2, fontWeight: '800' }, playlistStrip: { flexGrow: 0, marginBottom: 4 }, playlistPill: { flexDirection: 'row', alignItems: 'center', backgroundColor: C.panel, borderWidth: 1, borderColor: C.line, padding: 10, borderRadius: 11, marginRight: 8, maxWidth: 170 }, playlistIcon: { color: C.purple, fontSize: 17, marginRight: 7 }, playlistName: { color: C.text, fontSize: 12, fontWeight: '600' }, emptyHint: { color: C.muted, fontSize: 12, marginTop: 4 },
  createRow: { flexDirection: 'row', gap: 8, marginBottom: 10 }, formInput: { minHeight: 46, backgroundColor: C.panel2, borderWidth: 1, borderColor: C.line, borderRadius: 10, color: C.text, paddingHorizontal: 12, fontSize: 14, marginTop: 10 }, smallPrimary: { alignSelf: 'flex-end', backgroundColor: C.purple, borderRadius: 10, paddingHorizontal: 16, paddingVertical: 13, marginTop: 10 }, buttonText: { color: '#fff', fontWeight: '800', fontSize: 13 },
  empty: { alignItems: 'center', paddingHorizontal: 30, paddingTop: 58 }, emptyIcon: { color: C.purple, fontSize: 42, marginBottom: 9 }, emptyTitle: { color: C.text, fontSize: 17, fontWeight: '800', marginBottom: 7 }, outlineButton: { marginTop: 15, paddingHorizontal: 16, paddingVertical: 10, borderRadius: 10, borderWidth: 1, borderColor: C.line },
  accountContent: { padding: 18, paddingBottom: 28 }, accountCard: { backgroundColor: C.panel, padding: 18, borderRadius: 16, borderWidth: 1, borderColor: C.line, alignItems: 'stretch' }, accountIcon: { alignSelf: 'center', width: 55, height: 55, borderRadius: 28, textAlign: 'center', textAlignVertical: 'center', overflow: 'hidden', color: '#fff', backgroundColor: '#322960', fontSize: 26, fontWeight: '800', marginBottom: 13 }, accountTitle: { color: C.text, fontSize: 20, fontWeight: '800', textAlign: 'center', marginBottom: 5 },
  primaryButton: { height: 47, justifyContent: 'center', alignItems: 'center', backgroundColor: C.purple, borderRadius: 11, marginTop: 13, marginBottom: 14 },
  serverCard: { marginTop: 15, backgroundColor: C.panel, padding: 17, borderRadius: 14, borderWidth: 1, borderColor: C.line, gap: 7 }, serverUrl: { color: C.text, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 12 },
  modalBackdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: '#000b', zIndex: 4, justifyContent: 'center', padding: 22 }, modalCard: { backgroundColor: C.panel, padding: 18, borderRadius: 16, borderWidth: 1, borderColor: C.line }, modalActions: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: 9, marginTop: 9 },
  tabs: { flexDirection: 'row', paddingTop: 8, backgroundColor: C.bg, borderTopWidth: 1, borderTopColor: C.line }, tab: { flex: 1, alignItems: 'center', gap: 3, paddingVertical: 2 }, tabIcon: { color: C.muted, fontSize: 20 }, tabLabel: { color: C.muted, fontSize: 10, fontWeight: '600' }, loadMore: { alignSelf: 'center', paddingVertical: 14, paddingHorizontal: 22, borderRadius: 12, borderWidth: 1, borderColor: C.purple, marginTop: 6, marginBottom: 14 }, loadMoreText: { color: C.text, fontSize: 13, fontWeight: '700' },
  playerScroll: { flex: 1 }, playerScreen: { paddingHorizontal: 16, paddingBottom: 30 }, playerMedia: { height: 218, borderRadius: 18, backgroundColor: '#050506', overflow: 'hidden', marginBottom: 18, borderWidth: 1, borderColor: C.line }, playerPoster: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, width: '100%', height: '100%' }, playerVideo: { width: '100%', height: '100%' }, playerArtwork: { width: '100%', height: '100%' }, videoTag: { position: 'absolute', top: 12, left: 12, zIndex: 2, flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: '#090a12cc', paddingHorizontal: 9, paddingVertical: 6, borderRadius: 20 }, videoTagDot: { width: 6, height: 6, borderRadius: 4, backgroundColor: C.purple }, videoTagText: { color: '#fff', fontSize: 8, fontWeight: '800', letterSpacing: 1 }, videoMessage: { ...StyleSheet.absoluteFillObject, zIndex: 3, backgroundColor: '#050506aa', alignItems: 'center', justifyContent: 'center', padding: 20, gap: 10 }, videoMessageText: { color: C.text, textAlign: 'center', fontSize: 13 }, videoRetry: { backgroundColor: C.purple, borderRadius: 8, paddingHorizontal: 15, paddingVertical: 9 }, videoRetryText: { color: '#fff', fontWeight: '700', fontSize: 12 }, playerMusic: { color: C.purple, fontSize: 70 }, trackInfoRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 18 }, trackInfoCopy: { flex: 1 }, playerEyebrow: { color: C.purple, fontSize: 9, letterSpacing: 1.7, fontWeight: '800', marginBottom: 5 }, playerTitle: { color: C.text, fontSize: 20, lineHeight: 26, fontWeight: '800' }, playerArtist: { color: C.muted, fontSize: 13, marginTop: 3 }, playerFavorite: { width: 42, height: 42, alignItems: 'center', justifyContent: 'center', borderRadius: 22, backgroundColor: C.panel2 }, playerFavoriteGlyph: { color: C.text, fontSize: 24 }, progressLabels: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 0, marginBottom: 7 }, progressTime: { color: C.muted, fontSize: 11, fontVariant: ['tabular-nums'] }, progressTrack: { height: 4, borderRadius: 4, backgroundColor: C.line, overflow: 'hidden' }, progressFill: { height: '100%', backgroundColor: C.purple, borderRadius: 4 }, transportControls: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 17, marginBottom: 17 }, transportSide: { width: 38, alignItems: 'center' }, transportSideGlyph: { color: C.text, fontSize: 22, fontWeight: '700' }, seekButton: { width: 42, height: 42, borderRadius: 23, backgroundColor: C.panel, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: C.line }, seekGlyph: { color: C.text, fontSize: 10, fontWeight: '700' }, transportPlay: { width: 58, height: 58, borderRadius: 30, backgroundColor: C.purple, alignItems: 'center', justifyContent: 'center', shadowColor: C.purple, shadowOpacity: 0.35, shadowRadius: 13, shadowOffset: { width: 0, height: 5 }, elevation: 7 }, transportPlayGlyph: { color: '#fff', fontSize: 21, fontWeight: '900' }, adCard: { alignItems: 'center', backgroundColor: C.panel, borderRadius: 13, borderWidth: 1, borderColor: C.line, paddingTop: 8, paddingBottom: 5, marginBottom: 20, overflow: 'hidden' }, adLabel: { alignSelf: 'flex-start', color: C.muted, fontSize: 8, fontWeight: '800', letterSpacing: 1.4, paddingHorizontal: 11, paddingBottom: 5 }, queueHeading: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }, queueCount: { color: C.text, fontWeight: '700', marginTop: 3, fontSize: 12 }, queueRow: { minHeight: 58, flexDirection: 'row', alignItems: 'center', gap: 7, borderTopWidth: 1, borderTopColor: C.line, paddingVertical: 8 }, suggestionRow: { minHeight: 54, flexDirection: 'row', alignItems: 'center', gap: 10, borderTopWidth: 1, borderTopColor: C.line, paddingVertical: 8 }, queuePosition: { color: C.muted, fontSize: 10, width: 18 }, queueArt: { width: 40, height: 40, borderRadius: 7, backgroundColor: C.panel2 }, queueTrack: { flex: 1, minWidth: 65 }, queueTrackTitle: { color: C.text, fontSize: 11, fontWeight: '700' }, queueAction: { paddingHorizontal: 6, paddingVertical: 8, backgroundColor: C.panel2, borderRadius: 7 }, queueActionText: { color: C.text, fontSize: 9, fontWeight: '700' }, queueRemove: { paddingHorizontal: 3, paddingVertical: 8 }, suggestionAdd: { color: C.purple, fontSize: 10, fontWeight: '800' }, recommendationCard: { backgroundColor: '#201b36', borderRadius: 13, padding: 14, marginBottom: 14, borderWidth: 1, borderColor: '#383052' }, recommendationText: { color: C.text, fontSize: 14, fontWeight: '700', marginTop: 5 }, recommendationSub: { color: C.muted, fontSize: 11, marginTop: 3 }, recentSearchSection: { marginBottom: 14 }, recentSearchList: { marginTop: 8 }, recentSearchChip: { maxWidth: 180, marginRight: 8, borderRadius: 20, paddingHorizontal: 12, paddingVertical: 8, backgroundColor: C.panel, borderWidth: 1, borderColor: C.line }, recentSearchText: { color: C.text, fontSize: 11, fontWeight: '600' }, nowPlayingBadge: { flexDirection: 'row', alignItems: 'center', gap: 7, borderRadius: 18, backgroundColor: C.panel, borderColor: C.line, borderWidth: 1, paddingHorizontal: 11, paddingVertical: 8 }, nowPlayingBadgeText: { color: C.muted, fontSize: 9, fontWeight: '800', letterSpacing: 1 }, notificationCard: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 14, backgroundColor: C.panel, padding: 14, borderRadius: 14, borderWidth: 1, borderColor: C.line }, notificationIcon: { width: 38, height: 38, alignItems: 'center', justifyContent: 'center', borderRadius: 12, backgroundColor: '#29233e' }, notificationIconGlyph: { color: C.purple, fontSize: 23 }, notificationCopy: { color: C.muted, fontSize: 11, lineHeight: 16, marginTop: 4 }, notificationArrow: { color: C.purple, fontSize: 24, marginLeft: 3 },
});
