(function() {
  function normalizePart(value) {
    const trimmed = String(value || '').trim();
    return trimmed || '*';
  }

  function padTwoDigits(value) {
    return String(value).padStart(2, '0');
  }

  function describeSchedule(parts) {
    const [minute, hour, day, month, weekday] = parts;

    if (parts.join(' ') === '* * * * *') {
      return 'Runs every minute';
    }

    if (/^\*\/\d+$/.test(minute) && hour === '*' && day === '*' && month === '*' && weekday === '*') {
      return `Runs every ${minute.slice(2)} minutes`;
    }

    if (/^\d+$/.test(minute) && hour === '*' && day === '*' && month === '*' && weekday === '*') {
      return `Runs every hour at :${padTwoDigits(minute)}`;
    }

    if (/^\d+$/.test(minute) && /^\d+$/.test(hour) && day === '*' && month === '*' && weekday === '*') {
      return `Runs daily at ${padTwoDigits(hour)}:${padTwoDigits(minute)}`;
    }

    if (/^\d+$/.test(minute) && /^\d+$/.test(hour) && day === '*' && month === '*' && weekday === '1-5') {
      return `Runs weekdays at ${padTwoDigits(hour)}:${padTwoDigits(minute)}`;
    }

    return 'Custom schedule';
  }

  window.initCronBuilder = function initCronBuilder() {
    const scheduleInput = document.getElementById('schedule');
    if (!scheduleInput) {
      return;
    }

    const partInputs = [
      document.getElementById('cronMinute'),
      document.getElementById('cronHour'),
      document.getElementById('cronDay'),
      document.getElementById('cronMonth'),
      document.getElementById('cronWeekday'),
    ];
    const preview = document.getElementById('cronPreview');
    const description = document.getElementById('cronDescription');
    const presetButtons = document.querySelectorAll('[data-cron-preset]');

    function updatePreview(parts) {
      const cronString = parts.join(' ');
      scheduleInput.value = cronString;
      preview.textContent = cronString;
      description.textContent = describeSchedule(parts);
    }

    function syncFromInputs() {
      const parts = partInputs.map((input) => normalizePart(input.value));
      partInputs.forEach((input, index) => {
        input.value = parts[index];
      });
      updatePreview(parts);
    }

    function syncFromSchedule(rawSchedule) {
      const parts = String(rawSchedule || '').trim().split(/\s+/);
      if (parts.length !== 5) {
        preview.textContent = String(rawSchedule || '').trim();
        description.textContent = 'Custom schedule';
        return;
      }

      partInputs.forEach((input, index) => {
        input.value = parts[index];
      });
      updatePreview(parts);
    }

    partInputs.forEach((input) => {
      input.addEventListener('input', syncFromInputs);
      input.addEventListener('blur', syncFromInputs);
    });

    scheduleInput.addEventListener('input', () => {
      const raw = scheduleInput.value.trim();
      preview.textContent = raw;
      description.textContent = 'Custom schedule';

      const parts = raw.split(/\s+/);
      if (parts.length === 5) {
        syncFromSchedule(raw);
      }
    });

    presetButtons.forEach((button) => {
      button.addEventListener('click', () => {
        syncFromSchedule(button.dataset.cronPreset);
      });
    });

    syncFromSchedule(scheduleInput.value || '* * * * *');
  };
})();
