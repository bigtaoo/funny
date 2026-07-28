(function () {
  var listEl = document.getElementById('list');
  var bannerEl = document.getElementById('update-banner');

  function showBanner(info) {
    var label = info.kind === 'app' ? '工具箱有新版本' : '当前工具有新版本，已自动保存工作';
    bannerEl.innerHTML = '';
    var text = document.createElement('div');
    text.textContent = label;
    var btn = document.createElement('button');
    btn.textContent = '刷新';
    btn.addEventListener('click', function () {
      window.nwShell.applyUpdate();
    });
    bannerEl.appendChild(text);
    bannerEl.appendChild(btn);
    bannerEl.classList.add('visible');
  }

  function hideBanner() {
    bannerEl.classList.remove('visible');
    bannerEl.innerHTML = '';
  }

  function render(tools, activeId) {
    listEl.innerHTML = '';
    tools.forEach(function (tool) {
      var btn = document.createElement('button');
      btn.className = 'tool-btn' + (tool.id === activeId ? ' active' : '');
      btn.textContent = tool.label;
      btn.dataset.toolId = tool.id;
      btn.addEventListener('click', function () {
        window.nwShell.switchTool(tool.id);
      });
      listEl.appendChild(btn);
    });
  }

  function setActive(activeId) {
    Array.prototype.forEach.call(listEl.querySelectorAll('.tool-btn'), function (btn) {
      btn.classList.toggle('active', btn.dataset.toolId === activeId);
    });
  }

  if (!window.nwShell) {
    listEl.textContent = '（脱离桌面壳运行，无 nwShell 桥）';
    return;
  }

  window.nwShell.listTools().then(function (tools) {
    render(tools, tools[0] && tools[0].id);
  });
  window.nwShell.onActiveChanged(setActive);
  window.nwShell.onUpdateAvailable(showBanner);
  window.nwShell.onUpdateCleared(hideBanner);
})();
