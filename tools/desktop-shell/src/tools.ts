export interface ToolConfig {
  id: string;
  label: string;
  /** 开发模式地址；生产模式改指向各工具的托管地址（见 design/tools/desktop-shell/DESIGN.md §4.2），P1 暂只用 dev 地址。 */
  devUrl: string;
}

export const TOOLS: ToolConfig[] = [
  { id: 'animator', label: '动画编辑器', devUrl: 'http://localhost:9091' },
  { id: 'vfx-editor', label: '特效编辑器', devUrl: 'http://localhost:9094' },
  { id: 'level-editor', label: '关卡编辑器', devUrl: 'http://localhost:9092' },
  { id: 'map-editor', label: '地图编辑器', devUrl: 'http://localhost:9095' },
];

export const DEFAULT_TOOL_ID = TOOLS[0].id;
