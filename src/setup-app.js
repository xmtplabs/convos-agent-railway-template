// Served at /setup/app.js
// No fancy syntax: keep it maximally compatible.

(function () {
  var statusEl = document.getElementById('status');
  var authGroupEl = document.getElementById('authGroup');
  var authChoiceEl = document.getElementById('authChoice');
  var logEl = document.getElementById('log');

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

  function setStatus(s) {
    statusEl.textContent = s;
  }

  function renderAuth(groups) {
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
    setStatus('Loading...');
    return httpJson('/setup/api/status').then(function (j) {
      var ver = j.openclawVersion ? (' | ' + j.openclawVersion) : '';
      setStatus((j.configured ? 'Configured - open /openclaw' : 'Not configured - run setup below') + ver);
      renderAuth(j.authGroups || []);
      // If channels are unsupported, surface it for debugging.
      if (j.channelsAddHelp && j.channelsAddHelp.indexOf('telegram') === -1) {
        logEl.textContent += '\nNote: this openclaw build does not list telegram in `channels add --help`. Telegram auto-add will be skipped.\n';
      }

      // Attempt to load config editor content if present.
      if (configReloadEl && configTextEl) {
        loadConfigRaw();
      }

    }).catch(function (e) {
      setStatus('Error: ' + String(e));
    });
  }

  document.getElementById('run').onclick = function () {
    var payload = {
      flow: document.getElementById('flow').value,
      authChoice: authChoiceEl.value,
      authSecret: document.getElementById('authSecret').value,
      telegramToken: document.getElementById('telegramToken').value,
      discordToken: document.getElementById('discordToken').value,
      slackBotToken: document.getElementById('slackBotToken').value,
      slackAppToken: document.getElementById('slackAppToken').value
    };

    logEl.textContent = 'Running...\n';

    fetch('/setup/api/run', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (res) {
      return res.text();
    }).then(function (text) {
      var j;
      try { j = JSON.parse(text); } catch (_e) { j = { ok: false, output: text }; }
      logEl.textContent += (j.output || JSON.stringify(j, null, 2));
      return refreshStatus();
    }).catch(function (e) {
      logEl.textContent += '\nError: ' + String(e) + '\n';
    });
  };

  // Debug console runner
  function runConsole() {
    if (!consoleCmdEl || !consoleRunEl) return;
    var cmd = consoleCmdEl.value;
    var arg = consoleArgEl ? consoleArgEl.value : '';
    if (consoleOutEl) consoleOutEl.textContent = 'Running ' + cmd + '...\n';

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
    if (configOutEl) configOutEl.textContent = '';
    return httpJson('/setup/api/config/raw').then(function (j) {
      if (configPathEl) {
        configPathEl.textContent = 'Config file: ' + (j.path || '(unknown)') + (j.exists ? '' : ' (does not exist yet)');
      }
      configTextEl.value = j.content || '';
    }).catch(function (e) {
      if (configOutEl) configOutEl.textContent = 'Error loading config: ' + String(e);
    });
  }

  function saveConfigRaw() {
    if (!configTextEl) return;
    if (!confirm('Save config and restart gateway? A timestamped .bak backup will be created.')) return;
    if (configOutEl) configOutEl.textContent = 'Saving...\n';
    return httpJson('/setup/api/config/raw', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: configTextEl.value })
    }).then(function (j) {
      if (configOutEl) configOutEl.textContent = 'Saved: ' + (j.path || '') + '\nGateway restarted.\n';
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
    if (!confirm('Import backup? This overwrites files under /data and restarts the gateway.')) return;

    if (importOutEl) importOutEl.textContent = 'Uploading ' + f.name + ' (' + f.size + ' bytes)...\n';

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
      var channel = prompt('Enter channel (telegram, discord, or convos):');
      if (!channel) return;
      channel = channel.trim().toLowerCase();
      if (channel !== 'telegram' && channel !== 'discord' && channel !== 'convos') {
        alert('Channel must be "telegram", "discord", or "convos"');
        return;
      }
      var code = prompt('Enter pairing code (e.g. 3EY4PUYS):');
      if (!code) return;
      logEl.textContent += '\nApproving pairing for ' + channel + '...\n';
      fetch('/setup/api/pairing/approve', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channel: channel, code: code.trim() })
      }).then(function (r) { return r.text(); })
        .then(function (t) { logEl.textContent += t + '\n'; })
        .catch(function (e) { logEl.textContent += 'Error: ' + String(e) + '\n'; });
    };
  }

  document.getElementById('reset').onclick = function () {
    if (!confirm('Reset setup? This deletes the config file so onboarding can run again.')) return;
    logEl.textContent = 'Resetting...\n';
    fetch('/setup/api/reset', { method: 'POST', credentials: 'same-origin' })
      .then(function (res) { return res.text(); })
      .then(function (t) { logEl.textContent += t + '\n'; return refreshStatus(); })
      .catch(function (e) { logEl.textContent += 'Error: ' + String(e) + '\n'; });
  };

  // Convos setup
  var convosStatusEl = document.getElementById('convos-status');
  var convosSetupBtn = document.getElementById('convos-setup-btn');
  var convosCopyBtn = document.getElementById('convos-copy-btn');
  var convosResultEl = document.getElementById('convos-result');
  var convosSetupInProgress = false;
  var convosJoined = false;

  // Complete setup elements
  var completeSetupBtn = document.getElementById('completeSetup');
  var completeSetupStatusEl = document.getElementById('complete-setup-status');

  function checkConvosStatus() {
    if (!convosStatusEl) return;
    // Don't overwrite status while setup is in progress
    if (convosSetupInProgress) return;
    convosStatusEl.textContent = 'Checking status...';
    convosStatusEl.style.background = '#f5f5f5';

    httpJson('/setup/api/convos/status').then(function (data) {
      // Check again in case setup started while request was in flight
      if (convosSetupInProgress) return;
      if (data.configured) {
        var shortId = data.ownerConversationId ? data.ownerConversationId.slice(0, 12) + '...' : '';
        convosStatusEl.innerHTML = '<span style="color: green;">&#x2713;</span> Convos configured (conversation: ' + shortId + ')';
        convosStatusEl.style.background = '#e6ffe6';
      } else {
        convosStatusEl.innerHTML = '<span style="color: orange;">&#x25CB;</span> Not configured';
      }
    }).catch(function (err) {
      if (convosSetupInProgress) return;
      convosStatusEl.innerHTML = '<span style="color: red;">&#x2717;</span> Error checking status';
    });
  }

  function setupConvosChannel() {
    if (!convosStatusEl) return;
    convosSetupInProgress = true;
    var nameEl = document.getElementById('convos-name');
    var envEl = document.getElementById('convos-env');
    var name = nameEl ? nameEl.value || 'OpenClaw' : 'OpenClaw';
    var env = envEl ? envEl.value : 'production';

    if (convosSetupBtn) {
      convosSetupBtn.disabled = true;
      convosSetupBtn.textContent = 'Setting up...';
    }
    convosStatusEl.innerHTML = '<span style="color: blue;">&#x23F3;</span> Creating XMTP identity and conversation...';
    convosStatusEl.style.background = '#e6f3ff';

    // Show loading indicator
    var loadingEl = document.getElementById('convos-loading');
    if (loadingEl) loadingEl.style.display = 'block';

    httpJson('/setup/api/convos/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ env: env, name: name })
    }).then(function (data) {
      if (!data.success) {
        throw new Error(data.error || 'Setup failed');
      }

      // Hide loading, show invite section
      var loadingEl = document.getElementById('convos-loading');
      if (loadingEl) loadingEl.style.display = 'none';
      var inviteSection = document.getElementById('convos-invite-section');
      if (inviteSection) inviteSection.style.display = 'block';

      // Show QR code
      var canvas = document.getElementById('convos-qr');
      if (canvas && typeof QRCode !== 'undefined') {
        QRCode.toCanvas(canvas, data.inviteUrl, {
          width: 256,
          margin: 2,
          color: { dark: '#000000', light: '#ffffff' }
        }, function(err) {
          if (err) {
            console.error('QR code generation error:', err);
            canvas.style.display = 'none';
          }
        });
      } else {
        console.error('QRCode library not loaded or canvas not found');
      }

      var urlInput = document.getElementById('convos-invite-url');
      if (urlInput) urlInput.value = data.inviteUrl;
      if (convosResultEl) convosResultEl.style.display = 'block';

      // Show the setup section for regenerating
      var setupSection = document.getElementById('convos-setup-section');
      if (setupSection) setupSection.style.display = 'block';

      var shortId = data.conversationId ? data.conversationId.slice(0, 12) + '...' : '';
      convosStatusEl.innerHTML = '<span style="color: green;">&#x2713;</span> Invite generated! Scan the QR code below.';
      convosStatusEl.style.background = '#e6ffe6';

      if (convosSetupBtn) convosSetupBtn.textContent = 'Regenerate Invite';

      // Poll for join status
      var joinStatusText = document.getElementById('convos-join-status-text');
      var pollInterval = setInterval(function() {
        httpJson('/setup/api/convos/join-status').then(function(state) {
          if (state.joined && !convosJoined) {
            convosJoined = true;
            clearInterval(pollInterval);
            convosStatusEl.innerHTML = '<span style="color: green;">&#x2713;</span> Joined! Complete setup below.';
            convosStatusEl.style.background = '#e6ffe6';
            if (joinStatusText) {
              joinStatusText.innerHTML = '<strong style="color: green;">Connected!</strong> Click "Complete Setup" below to finish.';
            }
            // Enable the complete setup button
            if (completeSetupBtn) {
              completeSetupBtn.disabled = false;
              completeSetupBtn.style.opacity = '1';
            }
            if (completeSetupStatusEl) {
              completeSetupStatusEl.innerHTML = '<strong style="color: green;">Ready!</strong> Click the button to run setup and receive your pairing code in Convos.';
            }
          }
        }).catch(function() {
          // Ignore polling errors
        });
      }, 3000);

      // Stop polling after 5 minutes
      setTimeout(function() {
        clearInterval(pollInterval);
      }, 300000);
    }).catch(function (err) {
      convosStatusEl.innerHTML = '<span style="color: red;">&#x2717;</span> Error: ' + err.message;
      convosStatusEl.style.background = '#ffe6e6';
      if (convosSetupBtn) convosSetupBtn.textContent = 'Regenerate Invite';
      convosSetupInProgress = false; // Allow status check on error
      // Hide loading on error
      var loadingEl = document.getElementById('convos-loading');
      if (loadingEl) loadingEl.style.display = 'none';
      // Show setup section to retry
      var setupSection = document.getElementById('convos-setup-section');
      if (setupSection) setupSection.style.display = 'block';
    }).finally(function () {
      if (convosSetupBtn) convosSetupBtn.disabled = false;
    });
  }

  function copyConvosInvite() {
    var input = document.getElementById('convos-invite-url');
    if (input) {
      input.select();
      document.execCommand('copy');
      alert('Invite URL copied!');
    }
  }

  if (convosSetupBtn) convosSetupBtn.onclick = setupConvosChannel;
  if (convosCopyBtn) convosCopyBtn.onclick = copyConvosInvite;

  // Complete setup button handler
  function runCompleteSetup() {
    if (!completeSetupBtn) return;
    if (!convosJoined) {
      alert('Please scan the QR code and join the conversation first.');
      return;
    }

    var payload = {
      flow: document.getElementById('flow').value,
      authChoice: authChoiceEl.value,
      authSecret: document.getElementById('authSecret').value,
      telegramToken: document.getElementById('telegramToken').value,
      discordToken: document.getElementById('discordToken').value,
      slackBotToken: document.getElementById('slackBotToken').value,
      slackAppToken: document.getElementById('slackAppToken').value
    };

    completeSetupBtn.disabled = true;
    completeSetupBtn.textContent = 'Setting up...';
    logEl.textContent = 'Running setup...\n';

    httpJson('/setup/api/convos/complete-setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function(data) {
      logEl.textContent += (data.output || JSON.stringify(data, null, 2));
      if (data.ok) {
        completeSetupBtn.textContent = 'Setup Complete!';
        completeSetupBtn.style.background = '#16a34a';
        if (completeSetupStatusEl) {
          completeSetupStatusEl.innerHTML = '<strong style="color: green;">Done!</strong> Check your Convos chat for the pairing code and send it back to authenticate.';
        }
      } else {
        completeSetupBtn.disabled = false;
        completeSetupBtn.textContent = 'Complete Setup & Send Pairing Code';
      }
      return refreshStatus();
    }).catch(function(err) {
      logEl.textContent += '\nError: ' + String(err) + '\n';
      completeSetupBtn.disabled = false;
      completeSetupBtn.textContent = 'Complete Setup & Send Pairing Code';
    });
  }

  if (completeSetupBtn) completeSetupBtn.onclick = runCompleteSetup;

  refreshStatus();

  // Auto-generate Convos invite on page load
  httpJson('/setup/api/convos/status').then(function(data) {
    if (!data.configured) {
      // Auto-generate invite
      setupConvosChannel();
    } else {
      // Already configured
      convosStatusEl.innerHTML = '<span style="color: green;">&#x2713;</span> Convos already configured';
      convosStatusEl.style.background = '#e6ffe6';
      var loadingEl = document.getElementById('convos-loading');
      if (loadingEl) loadingEl.style.display = 'none';
      var setupSection = document.getElementById('convos-setup-section');
      if (setupSection) setupSection.style.display = 'block';
      // Show invite section option to regenerate
      var inviteSection = document.getElementById('convos-invite-section');
      if (inviteSection) inviteSection.style.display = 'none';
    }
  }).catch(function() {
    // On error, try to generate invite anyway
    setupConvosChannel();
  });
})();
