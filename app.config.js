const base = require('./app.json').expo;

const isProductionBuild = process.env.EAS_BUILD_PROFILE === 'production';
const admobAndroidAppId = process.env.ADMOB_ANDROID_APP_ID || 'ca-app-pub-3940256099942544~3347511713';
const admobIosAppId = process.env.ADMOB_IOS_APP_ID || 'ca-app-pub-3940256099942544~1458002511';
const oneSignalAppId = process.env.EXPO_PUBLIC_ONESIGNAL_APP_ID || '';
const admobBannerId = process.env.EXPO_PUBLIC_ADMOB_BANNER_ID || '';

if (isProductionBuild && (!process.env.ADMOB_ANDROID_APP_ID || !process.env.ADMOB_IOS_APP_ID || !admobBannerId || !oneSignalAppId)) {
  throw new Error('Set AdMob Android/iOS App IDs, EXPO_PUBLIC_ADMOB_BANNER_ID, and EXPO_PUBLIC_ONESIGNAL_APP_ID before making a production build.');
}

module.exports = {
  ...base,
  extra: { ...base.extra, oneSignalAppId, admobBannerId },
  ios: {
    ...base.ios,
    infoPlist: {
      ...base.ios?.infoPlist,
      UIBackgroundModes: [...new Set([...(base.ios?.infoPlist?.UIBackgroundModes || []), 'remote-notification'])],
    },
    entitlements: {
      ...base.ios?.entitlements,
      'aps-environment': isProductionBuild ? 'production' : 'development',
    },
  },
  plugins: [
    ['onesignal-expo-plugin', { mode: isProductionBuild ? 'production' : 'development', disableLocation: true }],
    ...(base.plugins || []),
    ['./plugins/with-pangle-maven'],
    ['react-native-google-mobile-ads', {
      androidAppId: admobAndroidAppId,
      iosAppId: admobIosAppId,
      delayAppMeasurementInit: true,
    }],
    '@react-native-google-mobile-ads/facebook',
    '@react-native-google-mobile-ads/pangle',
  ],
};
