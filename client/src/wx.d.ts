declare const GameGlobal: {
  PIXI?: any;
  [key: string]: any;
};

declare module wx {
  module cloud {
    function downloadFile(
      opts: Callback<{
        fileID: string;
        config?: {
          env: string;
        };
        success: (opts: { tempFilePath: string }) => void;
        fail: (opts: { errCode: number; errMsg: string }) => void;
      }>
    ): void;

    function init(opts: { env: string; traceUser?: boolean }): void;
  }

  module env {
    const USER_DATA_PATH: string;
  }

  function getChannelsLiveInfo(
    opts: Callback<{
      finderUserName: string;
    }>
  );

  interface Touch {
    identifier: number;
    pageX: number;
    pageY: number;
    clientX: number;
    clientY: number;
    force: number;
  }

  interface IRect {
    width: number;
    height: number;
    top: number;
    left: number;
    right: number;
    bottom: number;
  }

  interface IVideo {}

  function createVideo(opts: {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    src: string;
    poster?: string;
    initialTime?: number;
    playbackRate?: number;
    live?: boolean;
    objectFit?: 'fill' | 'contain' | 'cover';
    controls?: boolean;
    showProgress?: boolean;
    showProgressInControlMode?: boolean;
    backgroundColor?: string;
    autoplay?: boolean;
    loop?: boolean;
    muted?: boolean;
    obeyMuteSwitch?: boolean;
    enableProgressGesture?: boolean;
    enablePlayGesture?: boolean;
    showCenterPlayBtn?: boolean;
    underGameView?: boolean;
  }): IVideo;

  function previewImage(
    opts: Callback<{
      urls: string[];
      showmenu?: boolean;
      current?: string;
    }>
  ): void;

  function getMenuButtonBoundingClientRect(): IRect;

  interface IInnerAudioContext {
    /** URL of the audio resource for direct playback. Cloud file IDs supported since 2.2.3. */
    src: string;

    /** Playback start position (unit: s), default 0. */
    startTime: number;

    /** Whether to start playing automatically, default false. */
    autoplay: boolean;

    /** Whether to loop playback, default false. */
    loop: boolean;

    /** Whether to respect the system mute switch, default true. When false, audio plays even if the user has muted the device. This parameter has no effect since version 2.3.0; use wx.setInnerAudioOption instead. */
    obeyMuteSwitch: boolean;

    /** Volume. Range 0~1. Default 1. */
    volume: number;

    /** Playback speed. Range 0.5-2.0, default 1. (Android requires version 6 or above.) */
    playbackRate: number;

    /** Duration of the current audio (unit: s). Only returned when a valid src is set (read-only). */
    readonly duration: number;

    /** Current playback position (unit: s). Only returned when a valid src is set; time is kept to 6 decimal places (read-only). */
    readonly currentTime: number;

    /** Whether the audio is currently paused or stopped (read-only). */
    readonly paused: boolean;

    /** Buffered time point; guarantees content from the current playback position up to this point is buffered (read-only). */
    readonly buffered: number;

    /** Start playback. */
    play();

    /** Pause. Resuming after a pause continues from the paused position. */
    pause();

    /** Stop. Resuming after a stop restarts from the beginning. */
    stop();

    /** Seek to the specified position. */
    seek(position: number);

    /** Destroy the current instance. */
    destroy();

    /** Listen for the event when the audio enters a playable state. Smooth playback is not guaranteed. */
    onCanplay(cb: () => {});

    /** Remove listener for the audio-entering-playable-state event. */
    offCanplay(cb: () => {});

    /** Listen for the audio play event. */
    onPlay(cb: () => {});

    /** Remove listener for the audio play event. */
    offPlay(cb: () => {});

    /** Listen for the audio pause event. */
    onPause(cb: () => {});

    /** Remove listener for the audio pause event. */
    offPause(cb: () => {});

    /** Listen for the audio stop event. */
    onStop(cb: () => {});

    /** Remove listener for the audio stop event. */
    offStop(cb: () => {});

    /** Listen for the event when audio playback ends naturally. */
    onEnded(cb: () => {});

    /** Remove listener for the natural-end-of-playback event. */
    offEnded(cb: () => {});

    /** Listen for audio playback progress update events. */
    onTimeUpdate(cb: () => {});

    /** Remove listener for audio playback progress update events. */
    offTimeUpdate(cb: () => {});

    /** Listen for audio playback error events. */
    onError(cb: () => {});

    /** Remove listener for audio playback error events. */
    offError(cb: () => {});

    /** Listen for the audio buffering event. Triggered when audio must pause to load due to insufficient data. */
    onWaiting(cb: () => {});

    /** Remove listener for the audio buffering event. */
    offWaiting(cb: () => {});

    /** Listen for the event when a seek operation begins. */
    onSeeking(cb: () => {});

    /** Remove listener for the seek-start event. */
    offSeeking(cb: () => {});

    /** Listen for the event when a seek operation completes. */
    onSeeked(cb: () => {});

    /** Remove listener for the seek-complete event. */
    offSeeked(cb: () => {});
  }

  function createInnerAudioContext(opts?: { useWebAudioImplement?: boolean }): IInnerAudioContext;

  function loadSubpackage(
    opts: Callback<{
      name: string;
    }>
  ): void;

  function offTouchMove(fn: Function): void;
  function onTouchMove(
    opts: (opts: { touches: Touch[]; changedTouches: Touch[]; timeStamp: number }) => void
  ): void;

  function offTouchStart(fn: Function): void;
  function onTouchStart(
    opts: (opts: { touches: Touch[]; changedTouches: Touch[]; timeStamp: number }) => void
  ): void;

  function offTouchEnd(fn: Function): void;
  function onTouchEnd(
    opts: (opts: { touches: Touch[]; changedTouches: Touch[]; timeStamp: number }) => void
  ): void;

  function offTouchCancel(fn: Function): void;
  function onTouchCancel(
    opts: (opts: { touches: Touch[]; changedTouches: Touch[]; timeStamp: number }) => void
  ): void;

  function hideLoading(): void;

  function showLoading(opts: { title: string; mask?: boolean }): void;

  function showToast(opts: {
    title: string;
    icon?: 'success' | 'error' | 'loading' | 'none';
    duration?: number;
    mask?: boolean;
  }): void;

  function hideToast(): void;

  function setEnableDebug(
    opts: Callback<{
      enableDebug: boolean;
    }>
  ): void;

  function getFileSystemManager(): FileSystemManager;

  interface FileSystemManager {
    access: (
      opts: Callback<{
        path: string;
        fail?: (otps: { errMsg: string }) => void;
      }>
    ) => void;

    saveFile: (
      opts: Callback<{
        tempFilePath: string;
        filePath?: string;
        success?: (opts: { savedFilePath: string }) => void;
        fail?: (opts: { errMsg: string }) => void;
      }>
    ) => void;

    mkdir: (
      opts: Callback<{
        dirPath: string;
        recursive?: boolean;
        fail?: (opts: { errMsg: string }) => void;
      }>
    ) => void;

    readFile: (
      opts: Callback<{
        filePath: string;
        encoding?: 'ascii' | 'base64' | 'binary' | 'hex' | 'utf-8' | 'utf8';
        position?: number;
        length?: number;
        success?: (opts: { data: string | ArrayBuffer }) => void;
        fail?: (opts: { errMsg: string }) => void;
      }>
    ) => void;
  }

  /** Listen for the event triggered when the user taps the "Favorite" button in the menu (supported on Android 7.0.15+; not yet supported on iOS). */
  function onAddToFavorites(
    fn: () => {
      title: string;
      query: string;
      imageUrl: string;
      disableForward: boolean;
    }
  ): void;

  /** Get system information. */
  function getSystemInfoSync(): {
    windowWidth: number;
    windowHeight: number;
    pixelRatio: number;
  };

  function getWindowInfo();

  function createCanvas();
  function createImage();
  function request(any);

  function onShow(
    opt: (opt: {
      scene: string;
      query: any;
      shareTicket: string;
      referrerInfo: {
        appId: string;
        extraData: any;
      };
    }) => void
  ): void;

  function offShow(opt: () => void): void;

  function onHide(opt: () => void): void;

  function offHide(opt: () => void): void;

  function shareAppMessage(opt: {
    title?: string;
    imageUrl?: string;
    query?: string;
    imageUrlId?: string;
  }): void;

  function onShareAppMessage(
    opt: () => {
      title?: string;
      imageUrl?: string;
      query?: string;
      imageUrlId?: string;
    }
  ): void;

  function onShareTimeline(
    opt: () => {
      title?: string;
      imageUrl?: string;
      query?: string;
    }
  ): void;

  function showActionSheet(
    opts: Callback<{
      itemList: string[];
      itemColor?: string;
      success?: (opt: { tapIndex: number }) => void;
    }>
  ): void;

  interface IUserInfo {
    userInfo: {
      nickName: string;
      avatarUrl: string;
      /** 0: unknown 1: male 2: female */
      gender: 0 | 1 | 2;
      country: string;
      city: string;
      province: string;
      language: 'en' | 'zh_CN' | 'zh_TW';
    };
    iv: string;
    errMsg?: string;
    rawData: string;
    signature: string;
    encryptedData: string;
  }

  function createUserInfoButton(opts: {
    type: 'text' | 'image';
    text?: string;
    image?: string;
    withCredentials?: boolean;
    lang?: 'en' | 'zh_CN' | 'zh_TW';
    style: {
      left: number;
      top: number;
      width: number;
      height: number;
      backgroundColor: string;
      borderColor?: string;
      borderWidth?: number;
      borderRadius?: number;
      color: string;
      textAlign: 'left' | 'center' | 'right';
      fontSize: number;
      lineHeight: number;
    };
  }): {
    show: () => void;
    hide: () => void;
    destroy: () => void;
    onTap: (cb: (info: IUserInfo) => void) => void;
    offTap: () => void;
  };

  function getUserInfo(
    opts: Callback<{
      withCredentials?: boolean;
      lang?: 'en' | 'zh_CN' | 'zh_TW';
      success?: (info: IUserInfo) => void;
    }>
  ): void;

  function onAudioInterruptionEnd(cb: () => void): void;

  interface IBannerAd {
    style: {
      top: number;
      left: number;
      width: number;
      height: number;
    };
    show: () => Promise<unknown>;
    hide: () => Promise<unknown>;
    destroy: () => void;
    onError: (cb: (opts: { errMsg: string; errCode: number }) => void) => void;
    onResize: (cb: (opts: { width: number; height: number }) => void) => void;
  }

  function createBannerAd(opt: {
    adUnitId: string;
    adIntervals?: number;
    style?: {
      top?: number;
      left?: number;
      width?: number;
      height?: number;
    };
  }): IBannerAd;

  interface IGameClubButton {
    show: () => void;
    hide: () => void;
    style: Partial<{
      left: number;
      right: number;
      top: number;
      width: number;
      height: number;
      backgroundColor: number;
      borderColor: number;
      borderWidth: number;
      borderRadius: number;
      color: string;
      textAlign: 'left' | 'center' | 'right';
      fontSize: number;
      lineHeight: number;
    }>;
  }

  function createGameClubButton(
    opts: {
      type?: 'text' | 'string';
      text?: string;
      image?: string;
      icon: 'green' | 'white' | 'dark' | 'light';
    } & Pick<IGameClubButton, 'style'>
  ): IGameClubButton;

  interface ICustomAd {
    show: () => Promise<unknown>;
    hide: () => Promise<unknown>;
    destroy: () => void;
    onError: (cb: (opts: { errMsg: string; errCode: number }) => void) => void;
  }

  function createCustomAd(opt: {
    adUnitId: string;
    adIntervals?: number;
    style?: {
      left?: number;
      top?: number;
      fixed?: boolean;
    };
  }): ICustomAd;

  interface IInterstitialAd {
    show: () => Promise<unknown>;
    hide: () => void;
    destroy: () => void;
    onLoad: (cb: () => void) => void;
    onError: (cb: (opts: { errMsg: string; errCode: number }) => void) => void;
    onClose: (cb: () => void) => void;
    offClose: (cb: () => void) => void;
  }

  function createInterstitialAd(opts: { adUnitId: string }): IInterstitialAd;

  function loadFont(path: string): string;

  type Callback<T> = T &
    Omit<
      Partial<{
        fail: (...args: any[]) => void;
        success: (...args: any[]) => void;
        complete: () => void;
      }>,
      keyof T
    >;
}
