// Behaviour of the add / edit script form.
(function () {
  function toggleSourceType() {
    var sourceType = document.getElementById('sourceType').value;
    var pathGroup = document.getElementById('pathGroup');
    var commandGroup = document.getElementById('commandGroup');
    var sourceTypeHelp = document.getElementById('sourceTypeHelp');
    var pathInput = document.getElementById('path');
    var commandInput = document.getElementById('command');

    if (sourceType === 'command') {
      pathGroup.style.display = 'none';
      commandGroup.style.display = 'block';
      sourceTypeHelp.textContent = 'Execute a shell command directly';
      pathInput.removeAttribute('required');
      commandInput.setAttribute('required', 'required');
    } else {
      pathGroup.style.display = 'block';
      commandGroup.style.display = 'none';
      sourceTypeHelp.textContent = 'Run a script file from disk';
      pathInput.setAttribute('required', 'required');
      commandInput.removeAttribute('required');
    }
  }

  function toggleCronOptions() {
    var type = document.getElementById('type').value;
    var cronOptions = document.getElementById('cronOptions');
    var typeHelp = document.getElementById('typeHelp');

    if (type === 'cron') {
      cronOptions.style.display = 'block';
      typeHelp.textContent = 'Script will run on a schedule';
    } else {
      cronOptions.style.display = 'none';
      typeHelp.textContent = 'Script will run continuously and restart on crash';
    }
  }

  document.getElementById('sourceType').addEventListener('change', toggleSourceType);
  document.getElementById('type').addEventListener('change', toggleCronOptions);

  // Initialize on page load
  toggleSourceType();
  toggleCronOptions();
  window.initCronBuilder();
})();
