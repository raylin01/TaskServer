// The log viewer page.
//
// Everything that comes from the server (job names, log file names) is used as
// text or inside an encoded URL: pages are built with DOM calls, never with
// HTML strings.
(function () {
  var app = document.getElementById('logsApp');
  var scriptName = app.dataset.scriptName;
  var currentFile = app.dataset.selectedLog;
  // Initialize latest known log from server-side rendered stats
  var latestKnownLog = app.dataset.latestLog;
  var csrfToken = document.querySelector('meta[name="csrf-token"]').content;

  var refreshInterval = null;
  var tailMode = true;
  var loadedOffset = 0; // Lines loaded from end
  var isLoading = false;
  var hasMoreLogs = true;

  var logViewer = document.getElementById('logContent');

  function dataUrl(suffix, params) {
    var query = Object.keys(params || {}).map(function (key) {
      return encodeURIComponent(key) + '=' + encodeURIComponent(params[key]);
    }).join('&');
    return '/logs/' + encodeURIComponent(scriptName) + '/data' + suffix + (query ? '?' + query : '');
  }

  // Parsed JSON, or an Error carrying the server's message and status.
  function getJson(url, options) {
    return fetch(url, options).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) {
        if (!res.ok) {
          var error = new Error(body.error || ('Request failed (' + res.status + ')'));
          error.status = res.status;
          throw error;
        }
        return body;
      });
    });
  }

  function showError(error) {
    console.error('Failed to load logs:', error);
    logViewer.textContent = error.status === 404 ? 'Log file not found' : 'Could not load the log: ' + error.message;
  }

  // Load initial chunk in tail mode
  function loadInitialLogs() {
    if (!currentFile) return;

    getJson(dataUrl('/chunk', { file: currentFile, offset: 0, limit: 500, fromEnd: true }))
      .then(function (data) {
        logViewer.textContent = data.content;
        loadedOffset = data.loadedLines;
        hasMoreLogs = data.hasMore;

        if (tailMode) {
          scrollToBottom();
        }
      })
      .catch(showError);
  }

  // Load more logs when scrolling up
  function loadMoreLogs() {
    if (!currentFile || isLoading || !hasMoreLogs) return;

    isLoading = true;
    logViewer.classList.add('loading');
    var previousHeight = logViewer.scrollHeight;

    getJson(dataUrl('/chunk', { file: currentFile, offset: loadedOffset, limit: 500, fromEnd: true }))
      .then(function (data) {
        if (data.content) {
          // Prepend content
          logViewer.textContent = data.content + '\n' + logViewer.textContent;
          loadedOffset += data.loadedLines;
          hasMoreLogs = data.hasMore;

          // Maintain scroll position
          var newHeight = logViewer.scrollHeight;
          logViewer.scrollTop = newHeight - previousHeight;
        }
        isLoading = false;
        logViewer.classList.remove('loading');
      })
      .catch(function (error) {
        console.error('Failed to load more logs:', error);
        isLoading = false;
        logViewer.classList.remove('loading');
      });
  }

  function element(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // One entry of the file list.
  function buildLogItem(log, selectedLog) {
    var isError = log.name.includes('error');
    var link = element('a', 'log-item' + (log.name === selectedLog ? ' active' : ''));
    link.href = '/logs/' + encodeURIComponent(scriptName) + '?file=' + encodeURIComponent(log.name);
    link.dataset.type = isError ? 'error' : 'out';

    var header = element('div', 'log-item-header');
    header.appendChild(element('span', 'log-icon ' + (isError ? 'error' : 'out'), isError ? '✕' : '○'));
    header.appendChild(element('span', 'log-name', log.name));

    var meta = element('div', 'log-item-meta');
    meta.appendChild(element('span', 'log-size', log.sizeFormatted));
    meta.appendChild(element('span', 'log-time', new Date(log.mtime).toLocaleTimeString()));

    link.appendChild(header);
    link.appendChild(meta);
    return link;
  }

  function renderLogList(logs, selectedLog) {
    var logList = document.getElementById('logList');
    logList.replaceChildren.apply(logList, logs.map(function (log) { return buildLogItem(log, selectedLog); }));
  }

  function refreshLogs() {
    // First, check for new logs
    getJson(dataUrl('/stats'))
      .then(function (stats) {
        // Update Stats UI
        document.querySelector('.stat-card:nth-child(1) .stat-value').textContent = stats.count;
        document.querySelector('.stat-card:nth-child(2) .stat-value').textContent = formatBytes(stats.totalSize);
        if (stats.newest) {
          document.querySelector('.stat-card:nth-child(3) .stat-value').textContent = new Date(stats.newest.mtime).toLocaleString();
        }

        var forceFullRefresh = false;
        var newLatest = stats.newest ? stats.newest.name : '';

        // Check for new log file
        if (newLatest && newLatest !== latestKnownLog) {
          // If we are currently watching the "latest" log, switch to the NEW latest
          if (tailMode && currentFile === latestKnownLog) {
            currentFile = newLatest;
            latestKnownLog = newLatest;

            // Update URL parameter without reload
            var url = new URL(window.location);
            url.searchParams.set('file', currentFile);
            window.history.replaceState(null, '', url);

            // Reset scroll/offset state
            loadedOffset = 0;
            hasMoreLogs = true;

            // Force a full refresh to update the list and load updated content
            forceFullRefresh = true;
          } else {
            // Just update our knowledge of what's latest
            latestKnownLog = newLatest;
          }
        }

        // Continue with content refresh
        var urlParams = new URLSearchParams(window.location.search);
        var file = urlParams.get('file') || currentFile;

        if (tailMode && file && !forceFullRefresh) {
          // In tail mode, just append new content
          getJson(dataUrl('/chunk', { file: file, offset: 0, limit: 500, fromEnd: true }))
            .then(function (data) {
              var wasAtBottom = isScrolledToBottom();
              logViewer.textContent = data.content;

              if (wasAtBottom) {
                scrollToBottom();
              }
            })
            .catch(showError);
        } else {
          // Full refresh (updates list and content)
          getJson(dataUrl('', file ? { file: file } : {}))
            .then(function (data) {
              logViewer.textContent = data.logContent;
              document.getElementById('currentLog').textContent = data.selectedLog;

              renderLogList(data.logs, data.selectedLog);

              document.getElementById('fileCount').textContent = data.logs.length;
              currentFile = data.selectedLog;
              filterLogs(); // Reapply filter

              // specific logic if we just switched: scroll to bottom
              if (forceFullRefresh) {
                scrollToBottom();
              }
            })
            .catch(showError);
        }
      })
      .catch(function (error) { console.error('Failed to fetch stats:', error); });
  }

  function scrollToBottom() {
    logViewer.scrollTop = logViewer.scrollHeight;
  }

  function isScrolledToBottom() {
    return logViewer.scrollHeight - logViewer.scrollTop <= logViewer.clientHeight + 50;
  }

  function filterLogs() {
    var filter = document.getElementById('logFilter').value;
    var items = document.querySelectorAll('.log-item');
    var visibleCount = 0;

    items.forEach(function (item) {
      var type = item.getAttribute('data-type');
      if (filter === 'all' || filter === type) {
        item.style.display = 'block';
        visibleCount++;
      } else {
        item.style.display = 'none';
      }
    });

    document.getElementById('fileCount').textContent = visibleCount;
  }

  function downloadLog() {
    if (!currentFile) {
      alert('No log file selected');
      return;
    }
    // Create a download link
    var link = document.createElement('a');
    link.href = dataUrl('/download', { file: currentFile });
    link.download = currentFile;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  function deleteLog() {
    if (!currentFile) {
      alert('No log file selected');
      return;
    }

    if (!confirm('Are you sure you want to delete ' + currentFile + '?')) {
      return;
    }

    getJson(dataUrl('/delete', { file: currentFile }), { method: 'DELETE', headers: { 'X-CSRF-Token': csrfToken } })
      .then(function () {
        alert('Log file deleted successfully');
        window.location.reload();
      })
      .catch(function (error) {
        alert('Failed to delete log: ' + error.message);
      });
  }

  function formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes';
    var k = 1024;
    var sizes = ['Bytes', 'KB', 'MB', 'GB'];
    var i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
  }

  document.getElementById('refreshBtn').addEventListener('click', refreshLogs);
  document.getElementById('downloadBtn').addEventListener('click', downloadLog);
  document.getElementById('deleteBtn').addEventListener('click', deleteLog);
  document.getElementById('logFilter').addEventListener('change', filterLogs);

  // Scroll detection for progressive loading
  logViewer.addEventListener('scroll', function () {
    if (logViewer.scrollTop < 100 && hasMoreLogs && !isLoading) {
      loadMoreLogs();
    }
  });

  // Tail mode toggle
  document.getElementById('tailMode').addEventListener('change', function (e) {
    tailMode = e.target.checked;

    if (tailMode) {
      // Reset and load in tail mode
      loadedOffset = 0;
      hasMoreLogs = true;
      loadInitialLogs();
    }
  });

  // Auto-refresh toggle
  document.getElementById('autoRefresh').addEventListener('change', function (e) {
    if (e.target.checked) {
      refreshInterval = setInterval(refreshLogs, 5000);
    } else if (refreshInterval) {
      clearInterval(refreshInterval);
      refreshInterval = null;
    }
  });

  // Initialize
  if (currentFile && tailMode) {
    loadInitialLogs();
  }

  // Start auto-refresh by default
  refreshInterval = setInterval(refreshLogs, 5000);

  // Cleanup on page unload
  window.addEventListener('beforeunload', function () {
    if (refreshInterval) clearInterval(refreshInterval);
  });
})();
