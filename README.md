# Sonara

Sonara is a video-first music app. Its web app and backend run from this project and use their own SQLite database; they do not depend on the separate clone resources in Downloads.

## Start the web app

1. Install Node.js 22.5 or later and Python.
2. Install yt-dlp with `python -m pip install -U yt-dlp` (on Windows, use `py -m pip install -U yt-dlp` if `python` is unavailable).
3. From this folder, run `npm install` and then `npm start`.
4. Open `http://localhost:5000`.

## Run Sonara on your phone

Sonara now includes native Google Mobile Ads, Meta and Pangle mediation adapters, and OneSignal push support. These native SDKs do not run inside Expo Go. Build and install a Sonara development app on Android first:

1. Install and sign in to EAS CLI (`npm install -g eas-cli`, then `eas login`).
2. Run `npm run build:android:dev` and install the generated development APK on your phone.
3. Start the backend with `npm run server:lan`, then run `npm run mobile` and open the project in the Sonara development app (not Expo Go).
4. Keep the phone and computer on the same Wi-Fi. In Sonara, tap the connection badge or **Account → Server connection** and enter `http://YOUR-COMPUTER-IP:5000`.

Development uses Google's sample AdMob app IDs and test banner placement. Set `ADMOB_ANDROID_APP_ID`, `ADMOB_IOS_APP_ID`, `EXPO_PUBLIC_ADMOB_BANNER_ID`, and `EXPO_PUBLIC_ONESIGNAL_APP_ID` in `.env` for your own accounts. Production builds refuse to run until these values are configured. Push delivery also needs Firebase Cloud Messaging credentials added to the OneSignal dashboard. Meta and Pangle need active mediation groups and placement mappings in AdMob before their demand can serve.

The computer backend must stay running while you use it. The app uses the project's existing `assets/icon.png`, `assets/adaptive-icon.png`, and `assets/splash.png` assets.

The native player has a back control, a compact player while browsing, next/previous controls, and a queue. **Play next** puts a song at the front; **Queue** adds it at the end. Songs advance automatically when playback finishes. Discover builds an artist taste profile from favorites, playlist additions, and recent plays, then ranks matching videos while spreading picks across artists. Search combines the exact query with targeted variations, deduplicates the results, and offers **Load more search results** to keep exploring.

Background audio is configured in the app. Expo Go is useful for trying the player, but Android's sustained background playback requires the audio foreground service configured in the app's native build; the Expo config plugin is included for that build. The stock Expo Go app cannot receive that native configuration.

The backend creates its SQLite database in `data/`. FFmpeg is supplied by the `ffmpeg-static` package for adaptive streams and downloads. Set `PYTHON_PATH` or `FFMPEG_PATH` in `.env` if the programs are installed at custom locations. Set `HOST=0.0.0.0` only when you want other devices on your network to reach the app. The `server:lan` command enables this for phone testing without changing the regular `npm start` behavior.

## Music and playback

Search and discovery use YouTube video metadata. yt-dlp resolves video formats for Sonara's in-app video player. Adaptive video/audio formats are muxed by FFmpeg; combined MP4 formats stream directly. Streaming and downloads depend on the source video being available and may be affected by source changes or regional restrictions.

The download dialog offers MP4 and MP3 formats and asks users to confirm they own the media or have permission to download it. Use it only for media you have the right to save and in line with the source service's terms. Files you own can also be placed in `media/` or uploaded with **Add your music**. Supported local formats include MP3, M4A, AAC, OGG, WAV, FLAC, MP4, MOV, and WebM.

## Features

- Search and browse video songs, with minimum-length guidance and Enter-to-search
- In-app video playback, seek, volume, and playback-speed controls
- Previous, play/pause, next, shuffle, repeat, queue, and recently played history
- Favorites, playlists, playlist renaming, and share links that expire after 90 days
- MP4/MP3 downloads and local media upload/streaming
- Email/password accounts with salted password hashes and expiring session tokens

Accounts, playlists, queue, and listening history are stored locally. Back up `data/snapclone.sqlite` to preserve them. Sonara is an independent app and does not include Spotify's licensed catalog, subscriptions, or Premium account service.
