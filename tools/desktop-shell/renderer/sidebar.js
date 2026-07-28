(function () {
  var listEl = document.getElementById('list');

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
})();
