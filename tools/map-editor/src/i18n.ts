// Map Editor i18n — static UI chrome + status-message templates. See DESIGN.md §6.
export type Locale = 'en' | 'zh';

const STORAGE_KEY = 'map-editor-locale';

type Dict = Record<string, string>;

const en: Dict = {
  'app.title': 'Notebook Wars — Map Editor',
  'toolbar.title': 'Map Editor',
  'toolbar.worldId': 'World ID (seed)',
  'toolbar.regenerate': 'Regenerate',
  'tool.river.label': 'River',
  'tool.river.title': 'Click or drag to paint river tiles under the brush',
  'tool.mountain.label': 'Mountain',
  'tool.mountain.title': 'Click or drag to paint mountain tiles under the brush',
  'tool.carve.label': 'Carve',
  'tool.carve.title': 'Click or drag to carve a band open — turns obstacle into passable land',
  'tool.bridge.label': 'Bridge',
  'tool.bridge.title': 'Click or drag to place a capturable bridge (river crossing)',
  'tool.plankway.label': 'Plankway',
  'tool.plankway.title': 'Click or drag to place a capturable plankway (mountain crossing)',
  'tool.eraser.label': 'Eraser',
  'tool.eraser.title': 'Click or drag to clear painted tiles back to procedural terrain',
  'tool.city.label': 'City',
  'tool.city.title': 'Drag a city marker to move it (footprint stays the same)',
  'tool.pan.label': 'Pan',
  'tool.pan.title': 'Drag to pan the camera (also: middle-mouse-drag in any tool)',
  'toolbar.width': 'Brush Size',
  'toolbar.clearAll': 'Clear All',
  'toolbar.clearAll.title': 'Clear all painted terrain tiles',
  'toolbar.resetCities': 'Reset Cities',
  'toolbar.resetCities.title': 'Reset all city positions back to the generated defaults',
  'toolbar.centerView': 'Center View',
  'toolbar.centerView.title': 'Re-center the camera on the map',
  'toolbar.zoom': 'Zoom',
  'toolbar.lang': '中文',

  'insp.legend': 'Legend',
  'insp.tile': 'Tile',
  'insp.terrainTitle': 'Painted Terrain ({count})',
  'insp.pathsJson': 'Terrain — Export / Import JSON',
  'insp.citiesLegend': 'Cities Legend',
  'insp.selectedCity': 'Selected City',
  'insp.citiesJson': 'Cities — Export / Import JSON',
  'io.export': 'Export →',
  'io.import': '← Import',

  'tile.hoverHint': 'Hover the map to inspect a tile.',
  'tile.type': 'type',
  'tile.level': 'level',
  'tile.resource': 'resource',
  'resource.ink': 'Ink',
  'resource.paper': 'Paper',
  'resource.graphite': 'Graphite',
  'resource.metal': 'Metal',
  'resource.sticker': 'Sticker',

  'city.hint': 'Drag a city marker on the map while the City tool is active to move it (the World Center\'s 9×9 footprint keeps its shape when dragged). Click a marker to see its details.',
  'city.id': 'id',
  'city.kind': 'kind',
  'city.level': 'level',
  'city.footprint': 'footprint',
  'city.province': 'province',
  'city.coords': 'x: {x}, y: {y}',

  'publish.title': 'Publish to Server (§24)',
  'publish.adminBase': 'Admin API base (empty = same-origin)',
  'publish.username': 'Username',
  'publish.password': 'Password',
  'publish.login': 'Login',
  'publish.templateId': 'Template ID',
  'publish.templateId.placeholder': 'same as World ID by default',
  'publish.generateTemplate': 'Generate Template (seed from proceduralTile)',
  'publish.publishEdits': 'Publish Edits → Template',
  'publish.templatesTitle': 'Templates ({count})',
  'publish.refreshList': 'Refresh List',
  'publish.activate': 'Activate',
  'publish.delete': 'Delete',
  'publish.activateDeleteHint': 'Activating a template makes new worlds clone it as their terrain baseline (running worlds are unaffected). Deleting the currently active template is rejected.',
  'publish.logout': 'Logout',
  'publish.rasterizeHint': 'Rasterized terrain/cities only upload tiles that differ from the proceduralTile() baseline (diff-save, §24). Publishing is a one-way "bake": the server template is never converted back into the local terrain grid/city layer — keep using Export/Import JSON above to save editable source data.',
  'publish.template.active': ' (active)',

  'hint.pathsAndPan': 'Paint rivers/mountains: pick the River/Mountain tool, set Brush Size (tiles), then click or drag on the map to paint directly — same as an image editor\'s brush, wherever you paint immediately becomes that terrain. The Eraser tool clears painted tiles back to procedural terrain. The map renders a real isometric camera view with the game\'s art (same as in-game): use the Pan tool, or middle-mouse-drag in any tool, to pan; wheel or the Zoom slider to zoom.',

  'unit.tile': 'tile',
  'unit.tiles': 'tiles',
  'unit.city': 'city',
  'unit.cities': 'cities',

  'status.ready': 'Ready',
  'status.rendered': 'world="{worldId}" — {tiles} rendered in {ms}ms — painted {painted}, {cities}',
  'status.terrainExported': 'Exported {tiles}.',
  'status.terrainImported': 'Imported {tiles}.',
  'status.importFailed': 'Import failed: {msg}',
  'status.citiesExported': 'Exported {cities}.',
  'status.citiesImported': 'Imported {cities}.',
  'status.cityMoved': 'Moved city "{id}".',
  'status.pickTemplate': 'Pick or type a template ID first.',
  'status.activated': 'Activated template "{id}" — new worlds will clone it from now on.',
  'status.activateFailed': 'Activate failed: {msg}',
  'status.deleteConfirm': 'Delete template "{id}"? This cannot be undone.',
  'status.deleted': 'Deleted template "{id}".',
  'status.deleteFailed': 'Delete failed: {msg}',
  'status.loggedIn': 'Logged in.',
  'status.loginFailed': 'Login failed: {msg}',
  'status.loggedOut': 'Logged out.',
  'status.generating': 'Generating template "{id}" ({w}×{h})…',
  'status.generated': 'Generated template "{id}" — {tileCount} tiles (v{version}).',
  'status.generateFailed': 'Generate failed: {msg}',
  'status.rasterizing': 'Rasterizing edits…',
  'status.nothingToPublish': 'Nothing to publish — no tiles differ from the procedural baseline.',
  'status.publishing': 'Publishing {n} tile(s) to template "{id}"…',
  'status.published': 'Published {n} tile(s) to template "{id}".',
  'status.publishFailed': 'Publish failed: {msg}',
  'status.listFailed': 'Failed to list templates: {msg}',
};

const zh: Dict = {
  'app.title': 'Notebook Wars — 地图编辑器',
  'toolbar.title': '地图编辑器',
  'toolbar.worldId': '世界 ID（种子）',
  'toolbar.regenerate': '重新生成',
  'tool.river.label': '河流',
  'tool.river.title': '点击或拖动直接刷河流格子',
  'tool.mountain.label': '山脉',
  'tool.mountain.title': '点击或拖动直接刷山脉格子',
  'tool.carve.label': '开凿',
  'tool.carve.title': '点击或拖动把障碍带凿开为可通行平地',
  'tool.bridge.label': '桥',
  'tool.bridge.title': '点击或拖动放置可攻占的桥（跨河通道）',
  'tool.plankway.label': '栈道',
  'tool.plankway.title': '点击或拖动放置可攻占的栈道（跨山通道）',
  'tool.eraser.label': '橡皮',
  'tool.eraser.title': '点击或拖动把刷过的格子清回程序化地形',
  'tool.city.label': '城池',
  'tool.city.title': '拖动城池标记以移动位置（占地形状不变）',
  'tool.pan.label': '平移',
  'tool.pan.title': '拖动以平移相机（任意工具下按住鼠标中键也可平移）',
  'toolbar.width': '笔刷大小',
  'toolbar.clearAll': '清空全部',
  'toolbar.clearAll.title': '清空所有已刷的地形格子',
  'toolbar.resetCities': '重置城池',
  'toolbar.resetCities.title': '将所有城池位置重置为生成的默认坐标',
  'toolbar.centerView': '居中视角',
  'toolbar.centerView.title': '将相机重新居中到地图上',
  'toolbar.zoom': '缩放',
  'toolbar.lang': 'EN',

  'insp.legend': '图例',
  'insp.tile': '格子',
  'insp.terrainTitle': '已刷地形（{count}）',
  'insp.pathsJson': '地形 — 导出 / 导入 JSON',
  'insp.citiesLegend': '城池图例',
  'insp.selectedCity': '选中的城池',
  'insp.citiesJson': '城池 — 导出 / 导入 JSON',
  'io.export': '导出 →',
  'io.import': '← 导入',

  'tile.hoverHint': '将鼠标悬停在地图上查看格子信息。',
  'tile.type': '类型',
  'tile.level': '等级',
  'tile.resource': '资源',
  'resource.ink': '墨',
  'resource.paper': '纸',
  'resource.graphite': '碳',
  'resource.metal': '铁',
  'resource.sticker': '贴纸',

  'city.hint': 'City 工具下拖动地图上的城池标记即可移动坐标（世界中心 9×9 占地拖拽时保持形状）；点击标记查看详情。',
  'city.id': 'id',
  'city.kind': '类型',
  'city.level': '等级',
  'city.footprint': '占地',
  'city.province': '省份',
  'city.coords': 'x：{x}，y：{y}',

  'publish.title': '发布到服务端（§24）',
  'publish.adminBase': 'Admin API 地址（留空 = 同源）',
  'publish.username': '用户名',
  'publish.password': '密码',
  'publish.login': '登录',
  'publish.templateId': '模板 ID',
  'publish.templateId.placeholder': '默认同世界 ID',
  'publish.generateTemplate': '生成模板（以 proceduralTile 为种子）',
  'publish.publishEdits': '发布编辑内容 → 模板',
  'publish.templatesTitle': '模板列表（{count}）',
  'publish.refreshList': '刷新列表',
  'publish.activate': '激活',
  'publish.delete': '删除',
  'publish.activateDeleteHint': '激活后，新建的世界会以该模板为地形基线（不影响正在运行的世界）；删除当前已激活的模板会被拒绝。',
  'publish.logout': '登出',
  'publish.rasterizeHint': '栅格化地形/城池 → 只上传跟 proceduralTile() 基线不同的格子（diff-save，§24）。发布是单向"烘焙"：服务端模板不会反向生成回本地的地形格子图层/城池，请继续用上面的 导出/导入 JSON 保存可编辑源数据。',
  'publish.template.active': '（已激活）',

  'hint.pathsAndPan': '刷河流/山脉：选中 River/Mountain 工具，设置笔刷大小（格数），然后在地图上点击或拖动直接刷地形——跟图片编辑器的笔刷一样，刷到哪个格子哪个格子就立刻变成当前地形。Eraser 工具把刷过的格子清回程序化地形。地图是真实贴图的等距相机视角（跟游戏内一样）：Pan 工具或任意工具下按住中键拖动可平移，滚轮/Zoom 滑块缩放。',

  'unit.tile': '个格子',
  'unit.tiles': '个格子',
  'unit.city': '座城池',
  'unit.cities': '座城池',

  'status.ready': '就绪',
  'status.rendered': '世界="{worldId}" — 已渲染 {tiles}，耗时 {ms}ms — 已刷 {painted}，{cities}',
  'status.terrainExported': '已导出 {tiles}。',
  'status.terrainImported': '已导入 {tiles}。',
  'status.importFailed': '导入失败：{msg}',
  'status.citiesExported': '已导出 {cities}。',
  'status.citiesImported': '已导入 {cities}。',
  'status.cityMoved': '已移动城池 "{id}"。',
  'status.pickTemplate': '请先选择或输入模板 ID。',
  'status.activated': '已激活模板 "{id}" — 之后新建的世界将以此为地形基线。',
  'status.activateFailed': '激活失败：{msg}',
  'status.deleteConfirm': '删除模板 "{id}"？此操作不可撤销。',
  'status.deleted': '已删除模板 "{id}"。',
  'status.deleteFailed': '删除失败：{msg}',
  'status.loggedIn': '已登录。',
  'status.loginFailed': '登录失败：{msg}',
  'status.loggedOut': '已登出。',
  'status.generating': '正在生成模板 "{id}"（{w}×{h}）…',
  'status.generated': '已生成模板 "{id}" — {tileCount} 格（v{version}）。',
  'status.generateFailed': '生成失败：{msg}',
  'status.rasterizing': '正在栅格化编辑…',
  'status.nothingToPublish': '没有可发布的内容 — 没有格子与程序化基线不同。',
  'status.publishing': '正在发布 {n} 个格子到模板 "{id}"…',
  'status.published': '已发布 {n} 个格子到模板 "{id}"。',
  'status.publishFailed': '发布失败：{msg}',
  'status.listFailed': '获取模板列表失败：{msg}',
};

const dicts: Record<Locale, Dict> = { en, zh };

function detectInitialLocale(): Locale {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'en' || saved === 'zh') return saved;
  } catch {
    // localStorage unavailable (e.g. private browsing) — fall through to default.
  }
  return 'en';
}

let locale: Locale = detectInitialLocale();

export function getLocale(): Locale {
  return locale;
}

export function setLocale(next: Locale): void {
  locale = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // ignore — persistence is a nicety, not a requirement
  }
}

export function toggleLocale(): Locale {
  setLocale(locale === 'en' ? 'zh' : 'en');
  return locale;
}

export function t(key: string, vars?: Record<string, string | number>): string {
  let s = dicts[locale][key] ?? en[key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  }
  return s;
}
