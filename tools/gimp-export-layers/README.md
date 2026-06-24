# GIMP 插件：Export Layers (Cropped to Content)

GIMP **3.x** 的 Python 插件，把当前图片的**每个可见图层**按内容自动裁剪（去掉透明边框）后，单独导出为 PNG。

- 安全文件名（图层名里的特殊字符替换为 `_`，空名兜底为 `layer_N`）
- 交互模式弹窗选输出目录（默认定位到原图所在文件夹）；非交互模式落到原图目录或用户主目录
- 隐藏图层会被跳过

## 一键安装

> 需要先安装 GIMP 3.x 并至少运行过一次（生成配置目录）。

**Windows：**
```powershell
powershell -ExecutionPolicy Bypass -File install.ps1
```
或直接右键 `install.ps1` → 用 PowerShell 运行。

**Linux / macOS：**
```bash
./install.sh
```

脚本会自动探测 `%APPDATA%\GIMP\3.*`（Windows）或 `~/.config/GIMP/3.*` / `~/Library/Application Support/GIMP/3.*`（Unix）下的所有 3.x 版本目录并安装。

## 手动安装

把 `export_layers_cropped.py` 复制到（注意必须放在同名子文件夹里）：

- Windows：`%APPDATA%\GIMP\3.2\plug-ins\export_layers_cropped\export_layers_cropped.py`
- Linux：`~/.config/GIMP/3.2/plug-ins/export_layers_cropped/export_layers_cropped.py`（并 `chmod +x`）
- macOS：`~/Library/Application Support/GIMP/3.2/plug-ins/export_layers_cropped/export_layers_cropped.py`（并 `chmod +x`）

把 `3.2` 换成你实际的 GIMP 版本号。

## 使用

重启 GIMP → 打开多图层图片 → 菜单 **File > Export Layers (Cropped to Content)** → 选输出目录 → 每个可见图层导出为 `<图层名>.png`。
