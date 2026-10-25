// Asks before a script is deleted. The script name comes from a data attribute
// and is only ever used as text.
document.addEventListener('submit', function (event) {
  var name = event.target && event.target.dataset ? event.target.dataset.confirmDelete : undefined;
  if (name === undefined) return;
  var message = 'Are you sure you want to delete the script "' + name + '"?\n\n'
    + 'This will:\n- Remove the script from the configuration\n- Stop the script if it\'s running\n'
    + '- Keep the log files (you can delete them separately)\n\nThis action cannot be undone.';
  if (!window.confirm(message)) event.preventDefault();
});
