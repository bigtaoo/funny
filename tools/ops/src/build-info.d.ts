// 构建期由 webpack DefinePlugin 注入（git short hash + 构建时间），用于后台 header 显示当前线上版本。
declare const __BUILD_VERSION__: string;
declare const __BUILD_TIME__: string;
