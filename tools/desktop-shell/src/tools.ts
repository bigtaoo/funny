import { app } from 'electron';

export interface ToolConfig {
  id: string;
  label: string;
  /** 本地 `npm start` 开发地址 */
  devUrl: string;
  /** 生产托管地址（Cloudflare Workers，见各 wrangler/<tool>.jsonc + .github/workflows/<tool>-deploy.yml） */
  prodUrl: string;
}

export const TOOLS: ToolConfig[] = [
  { id: 'animator', label: '动画编辑器', devUrl: 'http://localhost:9091', prodUrl: 'https://animator.tao-wang-go.workers.dev' },
  { id: 'vfx-editor', label: '特效编辑器', devUrl: 'http://localhost:9094', prodUrl: 'https://vfx.gamestao.com' },
  { id: 'level-editor', label: '关卡编辑器', devUrl: 'http://localhost:9092', prodUrl: 'https://level.gamestao.com' },
  { id: 'map-editor', label: '地图编辑器', devUrl: 'http://localhost:9095', prodUrl: 'https://slg.gamestao.com' },
];

export const DEFAULT_TOOL_ID = TOOLS[0].id;

/** 打包安装后的正式版走生产托管地址；`electron .` 直跑源码开发时走本地 dev server。 */
export function resolveToolUrl(tool: ToolConfig): string {
  return app.isPackaged ? tool.prodUrl : tool.devUrl;
}
