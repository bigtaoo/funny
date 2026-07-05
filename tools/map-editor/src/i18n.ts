// Map Editor i18n — static UI chrome + status-message templates. See DESIGN.md §6.
export type Locale = 'en' | 'zh';

const STORAGE_KEY = 'map-editor-locale';

type Dict = Record<string, string>;

const en: Dict = {
  'app.title': 'Notebook Wars — Map Editor',
  'toolbar.title': 'Map Editor',
  'toolbar.worldId': 'World ID (seed)',
  'toolbar.regenerate': 'Regenerate',
  'tool.select.label': 'Select',
  'tool.select.title': 'Click a point to drag it, click a path to select it',
  'tool.river.label': 'River',
  'tool.river.title': 'Click to add points, double-click/Enter to finish, Esc to cancel',
  'tool.mountain.label': 'Mountain',
  'tool.mountain.title': 'Click to add points, double-click/Enter to finish, Esc to cancel',
  'tool.city.label': 'City',
  'tool.city.title': 'Drag a city marker to move it (footprint stays the same)',
  'tool.pan.label': 'Pan',
  'tool.pan.title': 'Drag to pan the camera (also: middle-mouse-drag in any tool)',
  'toolbar.width': 'Width',
  'toolbar.undoPoint': 'Undo Point',
  'toolbar.undoPoint.title': 'Remove last draft point (Backspace)',
  'toolbar.deletePath': 'Delete Path',
  'toolbar.deletePath.title': 'Delete selected path (Delete)',
  'toolbar.clearAll': 'Clear All',
  'toolbar.clearAll.title': 'Remove all river/mountain paths',
  'toolbar.resetCities': 'Reset Cities',
  'toolbar.resetCities.title': 'Reset all city positions back to the generated defaults',
  'toolbar.centerView': 'Center View',
  'toolbar.centerView.title': 'Re-center the camera on the map',
  'toolbar.zoom': 'Zoom',
  'toolbar.lang': '中文',

  'insp.legend': 'Legend',
  'insp.tile': 'Tile',
  'insp.pathsTitle': 'Paths ({count})',
  'insp.pathsJson': 'Paths — Export / Import JSON',
  'insp.citiesLegend': 'Cities Legend',
  'insp.selectedCity': 'Selected City',
  'insp.citiesJson': 'Cities — Export / Import JSON',
  'io.export': 'Export →',
  'io.import': '← Import',

  'tile.hoverHint': 'Hover the map to inspect a tile.',
  'tile.type': 'type',
  'tile.level': 'level',
  'tile.resource': 'resource',

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
  'publish.rasterizeHint': 'Rasterized paths/cities only upload tiles that differ from the proceduralTile() baseline (diff-save, §24). Publishing is a one-way "bake": the server template is never converted back into local river/city vector layers — keep using Export/Import JSON above to save editable source data.',
  'publish.template.active': ' (active)',

  'hint.pathsAndPan': 'Draw rivers/mountains: pick the River/Mountain tool, click on the map to add points, double-click or Enter to finish the path, Esc to cancel. In the Select tool, drag an endpoint or click a path to select it, then delete it. The map now renders a real isometric camera view with the game\'s art (same as in-game): use the Pan tool, or middle-mouse-drag in any tool, to pan; wheel or the Zoom slider to zoom.',

  'unit.tile': 'tile',
  'unit.tiles': 'tiles',
  'unit.path': 'path',
  'unit.paths': 'paths',
  'unit.city': 'city',
  'unit.cities': 'cities',

  'status.ready': 'Ready',
  'status.rendered': 'world="{worldId}" — {tiles} rendered in {ms}ms — {paths}, {cities}',
  'status.pathsExported': 'Exported {paths}.',
  'status.pathsImported': 'Imported {paths}.',
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
  'tool.select.label': '选择',
  'tool.select.title': '点击一个端点拖动它，点击一条路径选中它',
  'tool.river.label': '河流',
  'tool.river.title': '点击加点，双击/回车结束路径，Esc 取消',
  'tool.mountain.label': '山脉',
  'tool.mountain.title': '点击加点，双击/回车结束路径，Esc 取消',
  'tool.city.label': '城池',
  'tool.city.title': '拖动城池标记以移动位置（占地形状不变）',
  'tool.pan.label': '平移',
  'tool.pan.title': '拖动以平移相机（任意工具下按住鼠标中键也可平移）',
  'toolbar.width': '宽度',
  'toolbar.undoPoint': '撤销一点',
  'toolbar.undoPoint.title': '删除草稿中最后一个点（Backspace）',
  'toolbar.deletePath': '删除路径',
  'toolbar.deletePath.title': '删除选中的路径（Delete）',
  'toolbar.clearAll': '清空全部',
  'toolbar.clearAll.title': '移除所有河流/山脉路径',
  'toolbar.resetCities': '重置城池',
  'toolbar.resetCities.title': '将所有城池位置重置为生成的默认坐标',
  'toolbar.centerView': '居中视角',
  'toolbar.centerView.title': '将相机重新居中到地图上',
  'toolbar.zoom': '缩放',
  'toolbar.lang': 'EN',

  'insp.legend': '图例',
  'insp.tile': '格子',
  'insp.pathsTitle': '路径（{count}）',
  'insp.pathsJson': '路径 — 导出 / 导入 JSON',
  'insp.citiesLegend': '城池图例',
  'insp.selectedCity': '选中的城池',
  'insp.citiesJson': '城池 — 导出 / 导入 JSON',
  'io.export': '导出 →',
  'io.import': '← 导入',

  'tile.hoverHint': '将鼠标悬停在地图上查看格子信息。',
  'tile.type': '类型',
  'tile.level': '等级',
  'tile.resource': '资源',

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
  'publish.rasterizeHint': '栅格化路径/城池 → 只上传跟 proceduralTile() 基线不同的格子（diff-save，§24）。发布是单向"烘焙"：服务端模板不会反向生成回本地的河流/城池矢量图层，请继续用上面的 导出/导入 JSON 保存可编辑源数据。',
  'publish.template.active': '（已激活）',

  'hint.pathsAndPan': '画河流/山脉：选中 River/Mountain 工具后在地图上点击加点，双击或回车结束路径，Esc 取消。Select 工具下拖动端点、点击路径选中后可删除。地图现在是真实贴图的等距相机视角（跟游戏内一样）：Pan 工具或任意工具下按住中键拖动可平移，滚轮/Zoom 滑块缩放。',

  'unit.tile': '个格子',
  'unit.tiles': '个格子',
  'unit.path': '条路径',
  'unit.paths': '条路径',
  'unit.city': '座城池',
  'unit.cities': '座城池',

  'status.ready': '就绪',
  'status.rendered': '世界="{worldId}" — 已渲染 {tiles}，耗时 {ms}ms — {paths}，{cities}',
  'status.pathsExported': '已导出 {paths}。',
  'status.pathsImported': '已导入 {paths}。',
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
