// The interval shortcuts on the settings page.
document.querySelectorAll('[data-interval]').forEach(function (button) {
  button.addEventListener('click', function () {
    document.getElementById('checkInterval').value = button.dataset.interval;
  });
});
