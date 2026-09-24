/*
 * The only script on the site.
 *
 * Two jobs: register the service worker, and add passkeys where the browser
 * has them. Everything else works with this file blocked - every form is a
 * real form and every link is a real link - which is what lets the CSP be
 * script-src 'self' with no inline anything.
 */

(function () {
  'use strict';

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('/sw.js').catch(function () {
        /* A board that cannot install is still a board that works. */
      });
    });
  }

  registerPasskeyButton();
  pushButtons();

  var card = document.getElementById('passkey-card');
  var button = document.getElementById('passkey-login');
  var error = document.getElementById('passkey-error');

  // The button is hidden in the markup and only revealed once the browser has
  // actually been asked, so nobody is offered a sign-in method that will throw.
  if (!card || !button || !window.PublicKeyCredential) return;
  card.hidden = false;

  /* Adding a passkey from the "You" page, for an account that already exists. */
  function registerPasskeyButton() {
    var add = document.getElementById('passkey-add');
    if (!add || !window.PublicKeyCredential) return;
    add.hidden = false;

    add.addEventListener('click', function () {
      add.disabled = true;
      var challenge = '';

      fetch('/auth/passkey/register/start', { method: 'POST', headers: { accept: 'application/json' } })
        .then(function (response) {
          if (!response.ok) throw new Error('Could not start. Are you signed in?');
          return response.json();
        })
        .then(function (options) {
          challenge = options.challenge;
          return navigator.credentials.create({
            publicKey: {
              challenge: decode(options.challenge),
              rp: options.rp,
              user: {
                id: decode(options.user.id),
                name: options.user.name,
                displayName: options.user.displayName
              },
              pubKeyCredParams: options.pubKeyCredParams,
              authenticatorSelection: options.authenticatorSelection,
              excludeCredentials: (options.excludeCredentials || []).map(function (item) {
                return { id: decode(item.id), type: 'public-key' };
              }),
              timeout: 60000
            }
          });
        })
        .then(function (credential) {
          if (!credential) throw new Error('No passkey was created.');
          return fetch('/auth/passkey/register/verify', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              id: credential.id,
              rawId: encode(credential.rawId),
              type: credential.type,
              challenge: challenge,
              response: {
                clientDataJSON: encode(credential.response.clientDataJSON),
                attestationObject: encode(credential.response.attestationObject),
                transports: credential.response.getTransports ? credential.response.getTransports() : []
              }
            })
          });
        })
        .then(function (response) {
          if (!response.ok) throw new Error('That passkey was not accepted.');
          add.textContent = 'Passkey added';
        })
        .catch(function (problem) {
          add.disabled = false;
          if (problem && problem.name === 'NotAllowedError') return;
          var note = document.getElementById('passkey-add-error');
          if (note) {
            note.textContent = problem && problem.message ? problem.message : 'That did not work.';
            note.hidden = false;
          }
        });
    });
  }

  /*
   * Browser notifications, from the Notifications page. The button is hidden
   * in the markup and shown only once the browser has said it can push, so
   * nobody is offered a switch that does nothing. Subscribing needs a click:
   * browsers refuse a permission prompt that a page raised on its own.
   */
  function pushButtons() {
    var enable = document.getElementById('push-enable');
    var disable = document.getElementById('push-disable');
    var note = document.getElementById('push-error');
    if (!enable || !disable) return;
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return;

    var key = enable.getAttribute('data-key') || '';
    if (!key) return;

    function fail(message) {
      if (!note) return;
      note.textContent = message;
      note.hidden = false;
    }

    function current() {
      return navigator.serviceWorker.ready.then(function (registration) {
        return registration.pushManager.getSubscription();
      });
    }

    function reflect(subscription) {
      enable.hidden = !!subscription;
      disable.hidden = !subscription;
      enable.disabled = false;
      disable.disabled = false;
    }

    current().then(reflect).catch(function () { reflect(null); });

    enable.addEventListener('click', function () {
      enable.disabled = true;
      if (note) note.hidden = true;
      navigator.serviceWorker.ready
        .then(function (registration) {
          var options = { userVisibleOnly: true, applicationServerKey: decode(key) };
          return registration.pushManager.subscribe(options).catch(function (problem) {
            // A subscription left over from a different key (a board whose
            // keys were regenerated) makes subscribe() refuse. Drop it and
            // ask again, once.
            if (!problem || problem.name !== 'InvalidStateError') throw problem;
            return registration.pushManager.getSubscription()
              .then(function (stale) { return stale ? stale.unsubscribe() : null; })
              .then(function () { return registration.pushManager.subscribe(options); });
          });
        })
        .then(function (subscription) {
          return fetch('/api/v1/push/subscriptions', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(subscription.toJSON()),
          }).then(function (response) {
            if (!response.ok) throw new Error('The board did not accept this browser. Are you signed in?');
            reflect(subscription);
          });
        })
        .catch(function (problem) {
          enable.disabled = false;
          // Chromium reports a refused permission as AbortError
          // "Registration failed - permission denied", not NotAllowedError.
          if (problem && (problem.name === 'NotAllowedError' || Notification.permission === 'denied'
            || /permission/i.test(problem.message || ''))) {
            fail('Notifications are blocked for this site in the browser settings.');
            return;
          }
          // "Registration failed - push service error": the browser could not
          // reach its own push service, before this board is involved. Brave
          // ships with that service switched off; ungoogled and some distro
          // Chromium builds have none at all.
          if (problem && problem.name === 'AbortError') {
            fail(navigator.brave
              ? 'Brave has push messaging switched off. Turn on "Use Google services for push messaging" in brave://settings/privacy, restart Brave, then try again.'
              : 'This browser could not reach its push service, so it cannot receive notifications. Some Chromium builds ship without one; Chrome, Edge, Firefox and Safari work. Email notifications still arrive.');
            return;
          }
          fail(problem && problem.message ? problem.message : 'That did not work.');
        });
    });

    disable.addEventListener('click', function () {
      disable.disabled = true;
      current()
        .then(function (subscription) {
          if (!subscription) return null;
          var endpoint = subscription.endpoint;
          return subscription.unsubscribe().then(function () {
            return fetch('/api/v1/push/subscriptions', {
              method: 'DELETE',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ endpoint: endpoint }),
            });
          });
        })
        .then(function () { reflect(null); })
        .catch(function (problem) {
          disable.disabled = false;
          fail(problem && problem.message ? problem.message : 'That did not work.');
        });
    });
  }

  function decode(value) {
    var normal = value.replace(/-/g, '+').replace(/_/g, '/');
    var padded = normal + '==='.slice((normal.length + 3) % 4);
    var binary = atob(padded);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }

  function encode(buffer) {
    var bytes = new Uint8Array(buffer);
    var binary = '';
    for (var i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function show(message) {
    if (!error) return;
    error.textContent = message;
    error.hidden = false;
  }

  button.addEventListener('click', function () {
    button.disabled = true;
    if (error) error.hidden = true;

    fetch('/auth/passkey/challenge', { method: 'POST', headers: { accept: 'application/json' } })
      .then(function (response) {
        if (!response.ok) throw new Error('This board could not start a passkey sign-in.');
        return response.json();
      })
      .then(function (options) {
        return navigator.credentials.get({
          publicKey: {
            challenge: decode(options.challenge),
            rpId: options.rpId,
            userVerification: 'preferred',
            timeout: 60000,
          },
        });
      })
      .then(function (credential) {
        if (!credential) throw new Error('No passkey was chosen.');
        return fetch('/auth/passkey/verify', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            id: credential.id,
            rawId: encode(credential.rawId),
            type: credential.type,
            response: {
              clientDataJSON: encode(credential.response.clientDataJSON),
              authenticatorData: encode(credential.response.authenticatorData),
              signature: encode(credential.response.signature),
              userHandle: credential.response.userHandle
                ? encode(credential.response.userHandle)
                : null,
            },
          }),
        });
      })
      .then(function (response) {
        if (!response.ok) throw new Error('That passkey was not accepted.');
        window.location.href = '/me';
      })
      .catch(function (problem) {
        button.disabled = false;
        // A cancelled prompt is not a failure worth shouting about.
        if (problem && problem.name === 'NotAllowedError') return;
        show(problem && problem.message ? problem.message : 'Passkey sign-in did not work.');
      });
  });
})();
