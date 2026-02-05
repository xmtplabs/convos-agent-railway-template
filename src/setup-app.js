// Served at /setup/app.js
// No fancy syntax: keep it maximally compatible.

(function () {
  // Header status elements
  var statusDot = document.getElementById('status-dot');
  var statusText = document.getElementById('status-text');

  // Auth config elements
  var authGroupEl = document.getElementById('authGroup');
  var authChoiceEl = document.getElementById('authChoice');

  // Setup log elements
  var logEl = document.getElementById('log');
  var setupErrorEl = document.getElementById('setup-error');

  // Debug console
  var consoleCmdEl = document.getElementById('consoleCmd');
  var consoleArgEl = document.getElementById('consoleArg');
  var consoleRunEl = document.getElementById('consoleRun');
  var consoleOutEl = document.getElementById('consoleOut');

  // Config editor
  var configPathEl = document.getElementById('configPath');
  var configTextEl = document.getElementById('configText');
  var configReloadEl = document.getElementById('configReload');
  var configSaveEl = document.getElementById('configSave');
  var configOutEl = document.getElementById('configOut');

  // Import
  var importFileEl = document.getElementById('importFile');
  var importRunEl = document.getElementById('importRun');
  var importOutEl = document.getElementById('importOut');

  // Buttons
  var startSetupBtn = document.getElementById('startSetup');
  var completeSetupBtn = document.getElementById('completeSetup');

  // State tracking
  var convosJoined = false;

  function setStatus(text, state) {
    if (statusText) statusText.textContent = text;
    if (statusDot) {
      statusDot.className = 'status-dot';
      if (state === 'success') {
        statusDot.style.background = '#34C759';
      } else if (state === 'pending') {
        statusDot.classList.add('pending');
      } else if (state === 'error') {
        statusDot.classList.add('error');
      }
    }
  }

  function showError(message) {
    if (setupErrorEl) {
      setupErrorEl.textContent = message;
      setupErrorEl.style.display = 'block';
    }
  }

  function hideError() {
    if (setupErrorEl) {
      setupErrorEl.style.display = 'none';
    }
  }

  function showLog(content) {
    if (logEl) {
      logEl.textContent = content;
      logEl.style.display = 'block';
    }
  }

  function appendLog(content) {
    if (logEl) {
      logEl.textContent += content;
      logEl.style.display = 'block';
    }
  }

  function renderAuth(groups) {
    if (!authGroupEl) return;
    authGroupEl.innerHTML = '';
    for (var i = 0; i < groups.length; i++) {
      var g = groups[i];
      var opt = document.createElement('option');
      opt.value = g.value;
      opt.textContent = g.label + (g.hint ? ' - ' + g.hint : '');
      authGroupEl.appendChild(opt);
    }

    authGroupEl.onchange = function () {
      var sel = null;
      for (var j = 0; j < groups.length; j++) {
        if (groups[j].value === authGroupEl.value) sel = groups[j];
      }
      if (!authChoiceEl) return;
      authChoiceEl.innerHTML = '';
      var opts = (sel && sel.options) ? sel.options : [];
      for (var k = 0; k < opts.length; k++) {
        var o = opts[k];
        var opt2 = document.createElement('option');
        opt2.value = o.value;
        opt2.textContent = o.label + (o.hint ? ' - ' + o.hint : '');
        authChoiceEl.appendChild(opt2);
      }
    };

    authGroupEl.onchange();
  }

  function httpJson(url, opts) {
    opts = opts || {};
    opts.credentials = 'same-origin';
    return fetch(url, opts).then(function (res) {
      if (!res.ok) {
        return res.text().then(function (t) {
          throw new Error('HTTP ' + res.status + ': ' + (t || res.statusText));
        });
      }
      return res.json();
    });
  }

  function refreshStatus() {
    setStatus('Loading...', 'pending');
    return httpJson('/setup/api/status').then(function (j) {
      var ver = j.openclawVersion ? j.openclawVersion : '';
      if (j.configured) {
        setStatus('Ready' + (ver ? ' - ' + ver : ''), 'success');
      } else {
        setStatus('Setup required' + (ver ? ' - ' + ver : ''), 'pending');
      }
      renderAuth(j.authGroups || []);

      // Load config editor content
      if (configReloadEl && configTextEl) {
        loadConfigRaw();
      }
    }).catch(function (e) {
      setStatus('Error', 'error');
    });
  }

  // Debug console runner
  function runConsole() {
    if (!consoleCmdEl || !consoleRunEl) return;
    var cmd = consoleCmdEl.value;
    var arg = consoleArgEl ? consoleArgEl.value : '';
    if (consoleOutEl) {
      consoleOutEl.textContent = 'Running ' + cmd + '...\n';
      consoleOutEl.style.display = 'block';
    }

    return httpJson('/setup/api/console/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cmd: cmd, arg: arg })
    }).then(function (j) {
      if (consoleOutEl) consoleOutEl.textContent = (j.output || JSON.stringify(j, null, 2));
      return refreshStatus();
    }).catch(function (e) {
      if (consoleOutEl) consoleOutEl.textContent += '\nError: ' + String(e) + '\n';
    });
  }

  if (consoleRunEl) {
    consoleRunEl.onclick = runConsole;
  }

  // Config raw load/save
  function loadConfigRaw() {
    if (!configTextEl) return;
    if (configOutEl) configOutEl.style.display = 'none';
    return httpJson('/setup/api/config/raw').then(function (j) {
      if (configPathEl) {
        configPathEl.textContent = (j.path || '(unknown)') + (j.exists ? '' : ' (new)');
      }
      configTextEl.value = j.content || '';
    }).catch(function (e) {
      if (configOutEl) {
        configOutEl.textContent = 'Error loading config: ' + String(e);
        configOutEl.style.display = 'block';
      }
    });
  }

  function saveConfigRaw() {
    if (!configTextEl) return;
    if (!confirm('Save config and restart gateway?')) return;
    if (configOutEl) {
      configOutEl.textContent = 'Saving...\n';
      configOutEl.style.display = 'block';
    }
    return httpJson('/setup/api/config/raw', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: configTextEl.value })
    }).then(function (j) {
      if (configOutEl) configOutEl.textContent = 'Saved. Gateway restarted.\n';
      return refreshStatus();
    }).catch(function (e) {
      if (configOutEl) configOutEl.textContent += '\nError: ' + String(e) + '\n';
    });
  }

  if (configReloadEl) configReloadEl.onclick = loadConfigRaw;
  if (configSaveEl) configSaveEl.onclick = saveConfigRaw;

  // Import backup
  function runImport() {
    if (!importRunEl || !importFileEl) return;
    var f = importFileEl.files && importFileEl.files[0];
    if (!f) {
      alert('Pick a .tar.gz file first');
      return;
    }
    if (!confirm('Import backup? This overwrites files and restarts the gateway.')) return;

    if (importOutEl) {
      importOutEl.textContent = 'Uploading ' + f.name + '...\n';
      importOutEl.style.display = 'block';
    }

    return f.arrayBuffer().then(function (buf) {
      return fetch('/setup/import', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/gzip' },
        body: buf
      });
    }).then(function (res) {
      return res.text().then(function (t) {
        if (importOutEl) importOutEl.textContent += t + '\n';
        if (!res.ok) throw new Error('HTTP ' + res.status + ': ' + t);
        return refreshStatus();
      });
    }).catch(function (e) {
      if (importOutEl) importOutEl.textContent += '\nError: ' + String(e) + '\n';
    });
  }

  if (importRunEl) importRunEl.onclick = runImport;

  // Pairing approve helper
  var pairingBtn = document.getElementById('pairingApprove');
  if (pairingBtn) {
    pairingBtn.onclick = function () {
      var code = prompt('Enter pairing code (e.g. 3EY4PUYS):');
      if (!code) return;
      showLog('Approving pairing for convos...\n');
      fetch('/setup/api/pairing/approve', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channel: 'convos', code: code.trim() })
      }).then(function (r) { return r.text(); })
        .then(function (t) { appendLog(t + '\n'); })
        .catch(function (e) { appendLog('Error: ' + String(e) + '\n'); });
    };
  }

  // Reset button
  var resetBtn = document.getElementById('reset');
  if (resetBtn) {
    resetBtn.onclick = function () {
      if (!confirm('Reset setup? This deletes the config file.')) return;
      showLog('Resetting...\n');
      fetch('/setup/api/reset', { method: 'POST', credentials: 'same-origin' })
        .then(function (res) { return res.text(); })
        .then(function (t) {
          appendLog(t + '\n');
          // Restore UI to initial state so setup can be rerun
          convosJoined = false;
          if (startSetupBtn) {
            startSetupBtn.style.display = '';
            startSetupBtn.disabled = false;
            startSetupBtn.textContent = 'Start Setup';
          }
          if (completeSetupBtn) completeSetupBtn.style.display = 'none';
          var qrImg = document.getElementById('convos-qr');
          if (qrImg) qrImg.style.display = 'none';
          var qrInfoEl = document.getElementById('qr-info');
          if (qrInfoEl) qrInfoEl.style.display = 'none';
          var loadingEl = document.getElementById('convos-loading');
          if (loadingEl) {
            loadingEl.innerHTML = '<svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="#ccc" stroke-width="1.5"><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="3" height="3" /><rect x="18" y="14" width="3" height="3" /><rect x="14" y="18" width="3" height="3" /><rect x="18" y="18" width="3" height="3" /></svg><p>Click "Start Setup" to begin</p>';
            loadingEl.style.display = '';
          }
          return refreshStatus();
        })
        .catch(function (e) { appendLog('Error: ' + String(e) + '\n'); });
    };
  }

  // Start Setup - runs onboarding, starts gateway, calls convos.setup RPC
  function runStartSetup() {
    if (!startSetupBtn) return;

    hideError();

    var payload = {
      flow: document.getElementById('flow').value,
      authChoice: authChoiceEl ? authChoiceEl.value : '',
      authSecret: document.getElementById('authSecret') ? document.getElementById('authSecret').value : ''
    };

    startSetupBtn.disabled = true;
    startSetupBtn.textContent = 'Running onboarding...';
    showLog('Starting onboarding...\n');

    var loadingEl = document.getElementById('convos-loading');
    if (loadingEl) {
      loadingEl.innerHTML = '<svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="#007AFF" stroke-width="1.5"><circle cx="12" cy="12" r="10" stroke-dasharray="31.4" stroke-dashoffset="10"><animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="1s" repeatCount="indefinite"/></circle></svg><p>Running onboarding and starting gateway...</p>';
    }

    httpJson('/setup/api/convos/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (data) {
      if (!data.success) {
        throw new Error(data.error || 'Setup failed');
      }

      appendLog('Onboarding complete. Convos invite created.\n');

      // Hide loading, show QR image
      if (loadingEl) loadingEl.style.display = 'none';

      var qrImg = document.getElementById('convos-qr');
      if (qrImg && data.qrDataUrl) {
        qrImg.src = data.qrDataUrl;
        qrImg.style.display = 'block';
      }

      // Show QR info section
      var qrInfoEl = document.getElementById('qr-info');
      if (qrInfoEl) qrInfoEl.style.display = 'block';

      // Show invite URL
      var inviteUrlEl = document.getElementById('convos-invite-url');
      if (inviteUrlEl) {
        inviteUrlEl.textContent = data.inviteUrl;
        inviteUrlEl.style.display = 'block';
      }

      // Hide start button, update status
      startSetupBtn.style.display = 'none';
      setStatus('Waiting for join...', 'pending');

      // Poll for join status
      var pollInterval = setInterval(function () {
        httpJson('/setup/api/convos/join-status').then(function (state) {
          if (state.joined && !convosJoined) {
            convosJoined = true;
            clearInterval(pollInterval);

            // Update join status badge
            var joinStatusEl = document.getElementById('join-status');
            if (joinStatusEl) {
              joinStatusEl.textContent = 'Joined';
              joinStatusEl.className = 'qr-info-value status joined';
            }

            // Show the Finish Setup button
            if (completeSetupBtn) {
              completeSetupBtn.style.display = 'block';
            }

            setStatus('User joined - ready to finish', 'success');
          }
        }).catch(function () {
          // Ignore polling errors
        });
      }, 3000);

      // Stop polling after 5 minutes
      setTimeout(function () {
        clearInterval(pollInterval);
      }, 300000);
    }).catch(function (err) {
      if (loadingEl) {
        loadingEl.innerHTML = '<svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="#FF3B30" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg><p style="color: #FF3B30;">Error: ' + err.message + '</p>';
      }
      showError(err.message);
      startSetupBtn.disabled = false;
      startSetupBtn.textContent = 'Start Setup';
    });
  }

  // Finish Setup - calls convos.setup.complete RPC
  function runCompleteSetup() {
    if (!completeSetupBtn) return;

    hideError();
    completeSetupBtn.disabled = true;
    completeSetupBtn.textContent = 'Completing setup...';
    showLog('Finalizing Convos configuration...\n');

    httpJson('/setup/api/convos/complete-setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({})
    }).then(function (data) {
      if (data.ok) {
        appendLog('Setup complete!\n');
        completeSetupBtn.textContent = 'Setup Complete!';
        completeSetupBtn.classList.add('success');
        setStatus('Ready', 'success');
      } else {
        showError(data.error || 'Setup failed');
        completeSetupBtn.disabled = false;
        completeSetupBtn.textContent = 'Finish Setup';
      }
      return refreshStatus();
    }).catch(function (err) {
      appendLog('\nError: ' + String(err) + '\n');
      showError(String(err));
      completeSetupBtn.disabled = false;
      completeSetupBtn.textContent = 'Finish Setup';
    });
  }

  if (startSetupBtn) startSetupBtn.onclick = runStartSetup;
  if (completeSetupBtn) completeSetupBtn.onclick = runCompleteSetup;

  // Initial load
  refreshStatus();

  // Check if already configured
  httpJson('/setup/api/status').then(function (data) {
    if (data.configured) {
      var loadingEl = document.getElementById('convos-loading');
      if (loadingEl) {
        loadingEl.innerHTML = '<svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="#34C759" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><path d="M9 12l2 2 4-4"/></svg><p style="color: #34C759;">Already configured</p>';
      }
      if (startSetupBtn) startSetupBtn.style.display = 'none';
      setStatus('Ready', 'success');
    }
  }).catch(function () {
    // Ignore - status will be loaded by refreshStatus
  });
})();
