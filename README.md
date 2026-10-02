# Immersal VPS for Web
Immersal VPS for Web (aka WebAR)

This is a sample of how to use Immersal's Visual Positioning System (VPS) for on-device localization natively on a (mobile) Web browser. It can be used e.g. for persistent and anchored WebAR experiences, and to retrieve the user's position in global coordinates (latitude, longitude, altitude) from the camera image.

## What's new

### Oct 02, 2026

- Updated Wasm plugins for the new map file format introduced in Cloud Service 1.27.0
- Improved tracking stability / pose filtering
- Minor tidy up

### Feb 07, 2025

- Added Babylon.js sample
- Improved UI for localization testing (split into on-device / on-server modes)
- Improved pose filtering
- Minor bug fixes
- Recompiled Wasm components with Emscripten 4.0.2

## Features

- Localizes against Immersal maps created with the Mapper app ([App Store](https://apps.apple.com/app/immersal-mapper/id1466607906), [Play Store](https://play.google.com/store/apps/details?id=com.immersal.sdk.mapper)), BLK2GO, 360 cameras... 100% compatible.
- Very lean JavaScript ES6 module implementation
- WGS84/ECEF support (a localized pose contains the information in global coordinates if the map itself has been saved with GPS coordinates)
- Works in both portrait and landscape orientations
- Supports both Three.js and Babylon.js
- Uses the device IMU for orientation tracking, and continuous localization for translation (position) tracking to emulate SLAM
- Supports either one-shot or continuous localization
- Supports both on-device and on-server localization (through the Immersal REST API)

## Compatibility

- iOS Safari
- Android Chrome
- etc., latest versions -- should work on all modern mobile browsers, [contact us](mailto:support@immersal.com) if it doesn't

## Prerequisites

- [Immersal Developer account](https://developer.immersal.com/)
- [Immersal Pro plan subscription](https://developer.immersal.com/pricing/)
- Modern mobile device with:
  - WebGL support
  - Camera access
  - Orientation sensors

## Development Setup

### 1. HTTPS Setup
Modern browsers require HTTPS for accessing device cameras and sensors. For development, you can:

Using npm:
```bash
# Install http-server globally
npm install -g http-server
# Generate self-signed certificate
openssl req -newkey rsa:2048 -new -nodes -x509 -days 3650 -keyout key.pem -out cert.pem
# Start HTTPS server
http-server -S -C cert.pem -K key.pem
```

### 2. Configuration
1. Make a copy of `js/imConfig_template.js` as `js/imConfig.js`
2. Enter your developer token and map ID(s) in `imConfig.js`:
```javascript
export const immersalParams = {
  developerToken: "your_token", // From developer.immersal.com
  mapIds: [your_map_id], // From Immersal Mapper app
  continuousLocalization: true,
  continuousInterval: 16,
  imageDownScale: 0.25,
  solverType: 1,
};
```

### 3. Device Setup
For development and testing:
1. iOS Safari:
   - Enable Web Inspector: Settings > Safari > Advanced > Web Inspector
   - Connect iPhone to Mac for debugging
   - Use Safari on Mac: Develop > [Your iPhone] > [Web Page]

2. Android Chrome:
   - Enable USB debugging
   - Chrome on desktop: chrome://inspect

### 4. Required Permissions
The app requires access to:
- Camera (for localization)
- Device orientation sensors (for rotational tracking)
- HTTPS (required for accessing device features)

### 5. Troubleshooting
Common issues:
- 400 errors: Check developer token and map ID validity
- Camera not opening: Ensure HTTPS is properly set up
- Localization fails: Verify map ID and check if the area is mapped
- Orientation tracking issues: Check device sensor permissions

## Future improvements

- Common API to replace "SLAM tracking" with other tracking implementations (native Android Chrome WebXR/ARCore, App Clips, Zappar World Tracking, 8th Wall World Tracking, etc.)
- Accuracy, speed, and size

## Notes

- This is the "standalone version" of Immersal VPS for Web. You can also use it with Zappar's excellent [Mattercraft](https://zap.works/mattercraft/) tool, which is using Zappar's proprietary World Tracking (meaning that you don't have to use continuous localization with Immersal, every few seconds is probably enough). See videos: [Transforming location based AR experiences through the web with Mattercraft and Immersal](https://youtu.be/G0wbBQzFZJ0?si=wms08zdgDluagk5f), [Introducing Mattercraft's New Integration with Immersal VPS](https://youtu.be/39_lao6icSI?si=oyA05ySZnckTHrQ6)
- Support for on-device localization with 8th Wall or WeChat isn't planned at the moment, if you need it, [contact us](mailto:support@immersal.com) and let's talk.
