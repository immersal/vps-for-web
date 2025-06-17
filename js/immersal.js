import { Camera, toRadians, toDegrees, Quaternion, deviceDetection } from './imUtils.js';
import { default as trackerPluginModule } from './TrackerPlugin.js';

let Module;

trackerPluginModule().then(instance => {
  Module = instance;
  console.log(`[IMMERSAL] TrackerPlugin init`);

  window.updateKalmanParameters = Module.cwrap('updateKalmanParameters', null, ['number', 'number', 'number', 'number']);
  window.icvPosePut = Module.cwrap('icvPosePut', 'number', ['number', 'array', 'array']);
  window.icvPoseGet = Module.cwrap('icvPoseGet', 'number', ['number', 'number', 'number']);
  window.icvReset = Module.cwrap('icvReset', null, []);
  window.icvFocalLenPut = Module.cwrap('icvFocalLenPut', 'number', ['number']);
  window.icvFocalLenGet = Module.cwrap('icvFocalLenGet', 'number', []);
  window.icvFocalLenEstimateCount = Module.cwrap('icvFocalLenEstimateCount', 'number', []);
}).catch(error => {
  console.error('Error initializing WebAssembly module:', error);
});

export const createOrientationSensor = async () => {
  if (typeof DeviceOrientationEvent !== "undefined" && typeof DeviceMotionEvent.requestPermission === 'function') {
    try {
      const permissionState = await DeviceMotionEvent.requestPermission();
      if (permissionState === 'granted') {
        console.log(`[IMMERSAL] DeviceOrientation permissions ${permissionState}`);
        window.addEventListener('devicemotion', () => {});
      }
    } catch (error) {
      console.error(`[IMMERSAL] Error requesting DeviceOrientation permission:`, error);
    }
  }
}

class Immersal extends EventTarget {
  static BASE_URL         = "https://api.immersal.com/";
  static DEVICE_GET       = "devget";
  static DOWNLOAD_SPARSE  = "sparse";
  static DOWNLOAD_DENSE   = "dense";
  static SERVER_LOCALIZE  = "localize";
  static CAPTURE          = "capture";
  static DOWNLOAD_TEX     = "tex";
  static DOWNLOAD_MAP     = "map";
  static ECEF             = "ecef";

  static #VIDEO_WIDTH     = 960;
  static #VIDEO_HEIGHT    = 720;
  static #FOCAL_LEN_CONFIDENCE_THRESHOLD = 16;

  container;
  camera;
  deviceData;
  developerToken;
  mapIds;
  continuousInterval;
  imageDownScale = 0.25;
  solverType = 0;

  get continuousLocalization() {
    return this.#continuousLocalization;
  }
  set continuousLocalization(val) {
    if (val) {
      Immersal.#locWorker.addEventListener("message", this.handleLocWorkerEvent);
    } else {
      Immersal.#locWorker.removeEventListener("message", this.handleLocWorkerEvent);
    }
    this.localization.localizing = false;
    this.#continuousLocalization = val;
  }

  localization = {
    localizing: false,
    counter: 0,
    lastTime: 0,
    lastGyro: new Quaternion(0, 0, 0, 1)
  };

  localizeInfo = {
    handle: -1,
    position: {x: 0, y: 0, z: 0},
    rotation: new Quaternion(0, 0, 0, 1),
    wgs84: {latitude: 0, longitude: 0, altitude: 0},
    elapsedTime: 0
  }

  cameraData = {
    width: 0,
    height: 0,
    channels: 4,  // 4 == RGBA, 3 == RGB, 1 == greyscale
    buffer: new Uint8ClampedArray(),
    intrinsics: {fx: 0, fy: 0, ox: 0, oy: 0},
    position: {x: 0, y: 0, z: 0},
    rotation: new Quaternion(0, 0, 0, 1)
  }

  mapDict = {};
  gyroData = new Quaternion(0, 0, 0, 1);
  
  static #locWorker;

  static #mediaConstraints = {
    audio: false, 
    video: { 
      width: { ideal: this.#VIDEO_WIDTH }, 
      height: { ideal: this.#VIDEO_HEIGHT }, 
      aspectRatio: 4 / 3, 
      frameRate: { ideal: 60, min: 30 }, 
      facingMode: 'environment'
    }
  };

  #continuousLocalization = true;
  #focalLenConfidence = 0;
  #hasGyro = false;
  #angle = 0;
  #pos = new Float32Array(3);
  #rot = new Float32Array(4);
  #P = new Float32Array(3);
  #R = new Float32Array(4);
  #Q = new Quaternion(0, 0, 0, 1);
  #axisRot = new Quaternion(0, 0, 0, 1);

  #formatMapIds() {
    const mapIdArray = [this.mapIds.length];
    for (let i = 0; i < this.mapIds.length; i++) {
      mapIdArray[i] = {id: this.mapIds[i]};
    }
    return mapIdArray;
  }

  static #createPngWorker(fn) {
    const scripts = 'importScripts(\'https://cdnjs.cloudflare.com/ajax/libs/pako/2.1.0/pako.min.js\', \'https://cdn.jsdelivr.net/gh/photopea/UPNG.js/UPNG.js\')\n';
    const blob = new Blob([scripts, 'self.onmessage = ', fn.toString()], {type: 'text/javascript'});
    const url = URL.createObjectURL(blob);
    return new Worker(url);
  }

  static #pngWorker = this.#createPngWorker((e) => {
    const {pixels, width, height, channels} = e.data;
    let png;
    if (channels === 1) {
      png = self.UPNG.encodeLL([pixels], width, height, 1, 0, 8, 0);
    } else {
      png = self.UPNG.encode([pixels], width, height);
    }
    self.postMessage(png);
  });

  static #getDeviceInfo(developerToken) {
    return new Promise((resolve, reject) => {
      try {
        deviceDetection.then(data => {
          const {device} = data;
          const {hardwarevendor, hardwaremodel} = device;
          if (!hardwarevendor || !hardwaremodel) {
            reject(undefined);
            return;
          }
          const model = `${hardwarevendor} ${hardwaremodel}`;
          let json = {token: developerToken, model};
          json = JSON.stringify(json);

          fetch(Immersal.BASE_URL + Immersal.DEVICE_GET, {method: 'POST', body: json})
            .then(response => {
              if (!response.ok) {
                reject(new Error(response.status));
                return;
              }
              return response.json();
            })
            .then(data => {
              resolve(data);
            })
            .catch(error => {
              console.error(`[IMMERSAL] getDeviceInfo: Error, unable to load device info`, error);
              reject(undefined);
            });
        });
      } catch (e) {
        console.log(`[IMMERSAL] getDeviceInfo: Error, unable to load device info`, e);
        reject(undefined);
      }
    });
  }

  static Initialize(container, params) {
    if (params == null) {
      throw new Error(`[IMMERSAL] No parameters defined`);
    }

    return new Promise((resolve, reject) => {
      const onCameraReady = (camera) => {
        container.insertBefore(camera.el, container.firstChild);
        console.log(`[IMMERSAL] Using camera: ${camera.cameraLabel} (${camera.cameraId})`);
        params.container = container;
        params.camera = camera;

        if (params.deviceData != null) {
          resolve(new Immersal(params));
        } else {
          this.#getDeviceInfo(params.developerToken)
          .then(info => {
            console.log(`[IMMERSAL] Got device info:`, info);
            params.deviceData = info;
          })
          .catch(error => {
            console.log(`[IMMERSAL] No device data: ${error}`);
          })
          .finally(() => {
            resolve(new Immersal(params));
          });
        }
      }

      try {
        this.#locWorker = new Worker("./js/locWorker.js", {type: "module"});
        this.#locWorker.addEventListener("message", (e) => {
          const {type} = e.data;
          if (type === "Init") {
            console.log(`[IMMERSAL] PosePlugin init`);
            this.#locWorker.postMessage({type: "ValidateUser", data: params.developerToken});

            Camera.Initialize(this.#mediaConstraints)
              .then(camera => onCameraReady(camera))
              .catch(error => {
                console.log(`[IMMERSAL] Camera error: ${error}`);
                reject(error);
              });
          }
        }, {once: true});
        this.#locWorker.addEventListener("error", (e) => {
          reject(e);
        }, {once: true});
      } catch (error) {
        reject(error);
      }
    });
  }

  constructor(params) {
    super();
    const {container, camera, deviceData, developerToken, mapIds, continuousLocalization, continuousInterval, solverType, imageDownScale} = params
    
    this.#addEventListeners();

    this.container = container;
    this.camera = camera;
    this.deviceData = deviceData;
    this.developerToken = developerToken;
    this.mapIds = mapIds;
    this.solverType = solverType;
    this.continuousLocalization = continuousLocalization;
    this.continuousInterval = continuousInterval;
    this.imageDownScale = imageDownScale;

    this.#axisRot.rotateX(Math.PI);
  
    this.#initVideo();
  }

  #initVideo() {
    console.log(`[IMMERSAL] Video resolution: [${this.camera.width}x${this.camera.height}]`);
    const size = this.#resizeVideo(this.camera.width, this.camera.height, this.container.clientWidth, this.container.clientHeight);
    this.camera.el.style.width = size.width + "px";
    this.camera.el.style.height = size.height + "px";
    this.camera.el.width = size.width;
    this.camera.el.height = size.height;

    if (typeof BABYLON !== "undefined") {
      this.camera.el.style.left = size.x + "px";
      this.camera.el.style.top = size.y + "px";
    }

    this.#resetLocalization();
    console.log(`[IMMERSAL] Video resized`);
    this.dispatchEvent(new Event("resize"));
  }

  #resetLocalization() {
    this.cameraData.width = this.imageDownScale * this.camera.width;
    this.cameraData.height = this.imageDownScale * this.camera.height;

    if (this.deviceData) {
      let dw, dh, fx, fy, ox, oy;
      if (this.#isLandscape()) {
        dw = this.deviceData.height;
        dh = this.deviceData.width;
        fx = this.deviceData.fy;
        fy = this.deviceData.fx;
        ox = this.deviceData.oy;
        oy = this.deviceData.ox;
      } else {
        dw = this.deviceData.width;
        dh = this.deviceData.height;
        fx = this.deviceData.fx;
        fy = this.deviceData.fy;
        ox = this.deviceData.ox;
        oy = this.deviceData.oy;
      }
      const cx = this.camera.width / dw * this.imageDownScale;
      const cy = this.camera.height / dh * this.imageDownScale;

      this.cameraData.intrinsics.fx = cx * fx;
      this.cameraData.intrinsics.fy = cy * fy;
      this.cameraData.intrinsics.ox = cx * ox;
      this.cameraData.intrinsics.oy = cy * oy;
      console.log(`[IMMERSAL] Found device info for [${this.deviceData.model}], using scaled intrinsics:`, this.cameraData.intrinsics);
      this.#focalLenConfidence = 1;
    } else {
      this.#focalLenConfidence = 0;
      this.cameraData.intrinsics.ox = 0.5 * (this.#isLandscape() ? this.cameraData.height : this.cameraData.width);
      this.cameraData.intrinsics.oy = 0.5 * (this.#isLandscape() ? this.cameraData.width : this.cameraData.height);
    }

    if (typeof window.icvReset !== "undefined") {
      window.icvReset();
    }
    console.log(`[IMMERSAL] Localization parameters reset`);
  }

  #resizeVideo(srcW, srcH, dstW, dstH) {
    const rect = {};

    if (dstW / dstH > srcW / srcH) {
      const scale = dstW / srcW;
      rect.width = ~~(scale * srcW);
      rect.height = ~~(scale * srcH);
      rect.x = 0;
      rect.y = ~~((dstH - rect.height) * 0.5);
    } else {
      const scale = dstH / srcH;
      rect.width = ~~(scale * srcW);
      rect.height = ~~(scale * srcH);
      rect.x = ~~((dstW - rect.width) * 0.5);
      rect.y = 0;
    }
    return rect;
  }

  #getMediaConstraints() {
    const deviceId = this.camera?.cameraId;
    const videoConstraints = Immersal.#mediaConstraints.video;

    if (deviceId == null) {
      delete videoConstraints.deviceId;
      videoConstraints.facingMode = 'environment';
    } else {
      delete videoConstraints.facingMode;
      videoConstraints.deviceId = { exact: deviceId };
    }

    const constraints = Immersal.#mediaConstraints;
    constraints.video = videoConstraints;
    return constraints;
  }

  #resetCamera() {
    if (!this.camera) return;

    const constraints = this.#getMediaConstraints();

    this.camera.dispose();
    this.camera = null;

    const onCameraReady = (cam) => {
      this.localization.localizing = false;
      this.container.insertBefore(cam.el, this.container.firstChild);
      this.camera = cam;
      console.log(`[IMMERSAL] Using camera: ${this.camera.cameraLabel} (${this.camera.cameraId})`);
      this.#initVideo();
    }

    Camera.Initialize(constraints)
    .then(camera => onCameraReady(camera))
    .catch(error => {
      console.log(`[IMMERSAL] Camera error: ${error}`);
    });
  }

  #handleResize(e) {
    this.#resetCamera();
  }

  #handleFocus(e) {
    this.#resetCamera();
  }

  #handleScreenOrientationChange(e) {
    this.#angle = e.target.angle;

    if (this.#isLandscape()) {
      this.container.style.height = "101vh";
      window.scrollTo(0, 1);
    } else {
      this.container.style.height = "100vh";
      window.scrollTo(0, 0);
    }
  }

  #handleOrientation(e) {
    if (e.alpha == null || e.beta == null || e.gamma == null) return;

    this.#hasGyro = true;

    const yaw = toRadians(e.alpha);
    const pitch = toRadians(e.beta);
    const roll = toRadians(e.gamma);
    const orient = toRadians(this.#angle);

    const q0 = Quaternion.fromAxisAngle({x: 0, y: 0, z: 1}, -orient);
    const q1 = new Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5));
    const euler = {x: pitch, y: yaw, z: -roll};
    const q3 = new Quaternion().setFromEuler(euler);
    q3.multiply(q1);
    q3.multiply(q0);

    this.gyroData.set(q3.x, q3.y, q3.z, q3.w);
  }

  #addEventListeners() {
    this.handleLocWorkerEvent = this.#handleLocWorkerEvent.bind(this);
    this.handleOrientation = this.#handleOrientation.bind(this);
    this.handleResize = this.#handleResize.bind(this);
    this.handleFocus = this.#handleFocus.bind(this);
    this.handleScreenOrientationChange = this.#handleScreenOrientationChange.bind(this);

    window.addEventListener("deviceorientation", this.handleOrientation);
    window.addEventListener("resize", this.handleResize);
    window.addEventListener("focus", this.handleFocus);

    this.#angle = screen.orientation.angle || 0;
    screen.orientation.addEventListener("change", this.handleScreenOrientationChange);
  }

  getPngData() {
    return new Promise((resolve, reject) => {
      try {
        Immersal.#pngWorker.onmessage = (e) => {
          resolve(e.data);
        }
        Immersal.#pngWorker.onerror = (e) => {
          reject(e);
        }
        Immersal.#pngWorker.postMessage({pixels: this.cameraData.buffer, width: this.cameraData.width, height: this.cameraData.height, channels: this.cameraData.channels});
      } catch (error) {
        reject(error);
      }
    });
  }

  getEstimatedPose(time) {
    const ptrPos = Module._malloc(this.#pos.length * this.#pos.BYTES_PER_ELEMENT);
    const ptrRot = Module._malloc(this.#rot.length * this.#rot.BYTES_PER_ELEMENT);

    Module.HEAPF32.set(this.#pos, ptrPos >> 2);
    Module.HEAPF32.set(this.#rot, ptrRot >> 2);

    window.icvPoseGet(time, ptrPos, ptrRot);

    this.#pos.set( Module.HEAPF32.subarray(ptrPos >> 2, (ptrPos >> 2) + this.#pos.length) );
    this.#rot.set( Module.HEAPF32.subarray(ptrRot >> 2, (ptrRot >> 2) + this.#rot.length) );

    const pose = {position: Array.from(this.#pos), rotation: Array.from(this.#rot)};

    Module._free(ptrRot);
    Module._free(ptrPos);

    return pose;
  }

  loadMap(mapId) {
    return new Promise((resolve, reject) => {
      try {
        Immersal.#locWorker.addEventListener("message", (e) => {
          const {type, data} = e.data;

          if (type === "LoadMap") {
            const mapHandle = data;
            console.log(`[IMMERSAL] Map Loaded: [${mapHandle}]`);
            if (mapHandle >= 0) {
              const url = Immersal.BASE_URL + Immersal.ECEF;
              const json = {token: this.developerToken, id: mapId};
              fetch(url, {method: "POST", body: JSON.stringify(json)})
                .then(response => {
                  if (!response.ok) {
                    reject(new Error(response.status));
                    return;
                  }
                  return response.json();
                })
                .then(data => {
                  const mapData = {
                    id: mapId,
                    mapToEcef: (data && data.error === "none") ? data.ecef : [13]
                  };
                  this.mapDict[mapHandle] = mapData;
                  resolve(mapHandle);
                });
            }
          }
        }, {once: true});
        Immersal.#locWorker.addEventListener("error", (e) => {
          reject(e);
        }, {once: true});

        const url = Immersal.BASE_URL + Immersal.DOWNLOAD_MAP + "?token=" + this.developerToken + "&id=" + mapId;
        fetch(url)
          .then(response => {
            if (!response.ok) {
              reject(new Error(response.status));
              return;
            }
            return response.arrayBuffer();
          })
          .then(data => {
            const map = new Uint8Array(data);
            Immersal.#locWorker.postMessage({type: "LoadMap", data: map});
          });
      } catch (e) {
        console.log(`[IMMERSAL] loadMap: Error, unable to load map data`, e);
        reject(e);
      }
    });
  }

  freeMap(mapHandle) {
    return new Promise((resolve, reject) => {
      try {
        Immersal.#locWorker.addEventListener("message", (e) => {
          const {type, data} = e.data;

          if (type === "FreeMap") {
            if (data === 1) {
              console.log(`[IMMERSAL] Map Freed: [${mapHandle}]`);
              delete this.mapDict[mapHandle];
              resolve(data);
            } else {
              reject(data);
            }
          }
        }, {once: true});
        Immersal.#locWorker.addEventListener("error", (e) => {
          reject(e);
        }, {once: true});

        Immersal.#locWorker.postMessage({type: "FreeMap", data: mapHandle});
      } catch (e) {
        console.log(`[IMMERSAL] freepMap: Error, unable to free map data`, e);
        reject(e);
      }
    });
  }

  getMapDataByHandle(handle) {
    return this.mapDict[handle];
  }

  #handleLocalize(data) {
    const {r, pos, rot, time, focalLength, wgs84} = data;

    const now = performance.now();
  
    this.localizeInfo.handle = r;
    this.localizeInfo.elapsedTime = now - time;

    const success = (r >= 0) ? true : false;

    if (!this.continuousLocalization) {
      console.log(`[IMMERSAL] Localized in [${0.001 * this.localizeInfo.elapsedTime}] seconds, success: [${success}]`);
    }

    if (success) {
      if (this.#focalLenConfidence !== 1) {
        window.icvFocalLenPut(focalLength);
        this.cameraData.intrinsics.fx = this.cameraData.intrinsics.fy = window.icvFocalLenGet();

        if (window.icvFocalLenEstimateCount() >= Immersal.#FOCAL_LEN_CONFIDENCE_THRESHOLD) {
          this.cameraData.intrinsics.fx = this.cameraData.intrinsics.fy = window.icvFocalLenGet();
          console.log(`[IMMERSAL] Focal length estimated`, this.cameraData.intrinsics);
          this.#focalLenConfidence = 1;
        }
      }

      this.#Q.set(rot[0], rot[1], rot[2], rot[3]);
      this.#Q.multiply(this.#axisRot);

      const gyro = this.localization.lastGyro.clone();
      gyro.invert();
      this.#Q.multiply(gyro);

      this.#P.set(pos);
      this.#R.set(Object.values(this.#Q));

      window.icvPosePut(time, new Uint8Array(this.#P.buffer), new Uint8Array(this.#R.buffer));

      this.localizeInfo.position.x = pos[0];
      this.localizeInfo.position.y = pos[1];
      this.localizeInfo.position.z = pos[2];
      this.localizeInfo.rotation.set(this.#Q.x, this.#Q.y, this.#Q.z, this.#Q.w);
  
      if (wgs84) {
        this.localizeInfo.wgs84.latitude = wgs84[0];
        this.localizeInfo.wgs84.longitude = wgs84[1];
        this.localizeInfo.wgs84.altitude = wgs84[2];
      }

      this.localization.counter++;
    }

    this.localization.localizing = false;
  }

  #handleLocWorkerEvent(e) {
    const {type, data} = e.data;

    if (type === "Localize") {
      this.#handleLocalize(data);
    }
  }

  #isLandscape() {
    let val = false;
    switch (this.#angle) {
      case 0: // portrait-primary
        val = false; break;
      case 90:  // landscape-primary
        val = true; break;
      case 180: // portrait-secondary
        val = false; break;
      case 270: // landscape-secondary
        val = true; break;
      default:
        val = false;
    }
    return val;
//    return window.innerWidth > window.innerHeight;
  }

  localizeDevice(time) {
    if (this.localization.localizing) {
      return;
    }

    if (this.#focalLenConfidence === 1) {
      if (this.continuousInterval > 0) {
        if ((time - this.localization.lastTime < this.continuousInterval)) {
          return;
        }
      }
    }

    this.localization.localizing = true;
    this.localization.lastTime = time;

    if (this.#hasGyro) {
      const gyro = this.gyroData.clone();
      const camRot = gyro.clone().multiply(this.#axisRot);
      this.localization.lastGyro.set(gyro.x, gyro.y, gyro.z, gyro.w);
      this.cameraData.rotation.set(camRot.x, camRot.y, camRot.z, camRot.w);
    } else {
      this.solverType = 0;
    }

    this.cameraData.buffer = this.camera?.getImageData(this.imageDownScale);

    if (!this.cameraData.buffer) return;

    const intr = Object.values(this.cameraData.intrinsics);

    if (this.#focalLenConfidence !== 1) {
      intr[0] = intr[1] = 0.0;
    }

    Immersal.#locWorker.postMessage({
      type: "Localize", 
      data: [
        this.cameraData.width, 
        this.cameraData.height, 
        this.cameraData.channels, 
        intr,
        this.cameraData.buffer, 
        time, 
        this.solverType, 
        Object.values(this.cameraData.rotation),
        this.mapDict
        ]
    });
  }

  getVFov() {
    return toDegrees( 2.0 * Math.atan(this.cameraData.height * 0.5 / this.cameraData.intrinsics.fy) );
  }

  getHFov() {
    return toDegrees( 2.0 * Math.atan(this.cameraData.width * 0.5 / this.cameraData.intrinsics.fx) );
  }

  localizeDeviceAsync() {
    return new Promise((resolve, reject) => {
      try {
        if (this.localization.localizing) {
          reject("[IMMERSAL] Already localizing");
          return;
        }

        Immersal.#locWorker.addEventListener("message", (e) => {
          const {type, data} = e.data;
          
          if (type === "Localize") {
            this.#handleLocalize(data);

            if (this.localizeInfo.handle >= 0) {
              resolve(this.localizeInfo);
            } else {
              reject("[IMMERSAL] Localization failed");
            }
          }
        }, {once: true});
        Immersal.#locWorker.addEventListener("error", (e) => {
          this.localization.localizing = false;
          reject(e);
        }, {once: true});

        this.localizeDevice(performance.now());
      } catch (e) {
        console.log(`[IMMERSAL] localizeDeviceAsync: Error:`, e);
        this.localization.localizing = false;
        reject(e);
      }
    });
  }

  localizeServerAsync() {
    return new Promise((resolve, reject) => {
      try {
        if (this.localization.localizing) {
          reject("[IMMERSAL] Already localizing");
          return;
        }

        const time = performance.now();

        this.localization.localizing = true;
        this.localization.lastTime = time;
    
        if (this.#hasGyro) {
          const gyro = this.gyroData.clone();
          const camRot = gyro.clone().multiply(this.#axisRot);
          this.localization.lastGyro.set(gyro.x, gyro.y, gyro.z, gyro.w);
          this.cameraData.rotation.set(camRot.x, camRot.y, camRot.z, camRot.w);
        } else {
          this.solverType = 0;
        }
        
        this.cameraData.buffer = this.camera?.getImageData(this.imageDownScale);

        if (!this.cameraData.buffer) {
          this.localization.localizing = false;
          reject("[IMMERSAL] Cannot obtain camera data");
          return;
        }
    
        this.getPngData()
          .then(encodedImage => {
            const json = {
              token: this.developerToken,
              fx: this.cameraData.intrinsics.fx,
              fy: this.cameraData.intrinsics.fy,
              ox: this.cameraData.intrinsics.ox,
              oy: this.cameraData.intrinsics.oy,
              qx: this.cameraData.rotation.x,
              qy: this.cameraData.rotation.y,
              qz: this.cameraData.rotation.z,
              qw: this.cameraData.rotation.w,
              solverType: this.solverType,
              mapIds: this.#formatMapIds(),
            };

            const payload = new Blob([JSON.stringify(json), '\0', encodedImage]);
            
            fetch(Immersal.BASE_URL + Immersal.SERVER_LOCALIZE, {method: 'POST', body: payload})
              .then(response => {
                if (!response.ok) {
                  this.localization.localizing = false;
                  reject(new Error(response.status));
                  return;
                }
                return response.json();
              })
              .then(data => {
                if (data.error !== "none") {
                  throw new Error(data.error);
                }
        
                if (data.success) {
                  const q = new Quaternion().fromRotationMatrix([
                    [data.r00, data.r01, data.r02],
                    [data.r10, data.r11, data.r12],
                    [data.r20, data.r21, data.r22]
                  ]);
                  const locData = {
                    r: data.map,
                    pos: [data.px, data.py, data.pz],
                    rot: [q.x, q.y, q.z, q.w],
                    time: time,
                    focalLength: this.cameraData.intrinsics.fx
                  };

                  this.#handleLocalize(locData);

                  resolve(this.localizeInfo);
                } else {
                  this.localization.localizing = false;
                  reject("[IMMERSAL] Localization failed");
                }
              })
              .catch(error => {
                console.error(`[IMMERSAL] localizeServerAsync: Error:`, error);
                this.localization.localizing = false;
                reject(error);
              });
          })
          .catch(error => {
            console.error(`[IMMERSAL] getPngData: Error:`, error);
            this.localization.localizing = false;
            reject(error);
          });
      } catch (e) {
        console.log(`[IMMERSAL] localizeServerAsync: Error:`, e);
        this.localization.localizing = false;
        reject(e);
      }
    });
  }
}

export { Immersal };