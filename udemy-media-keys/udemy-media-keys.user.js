// ==UserScript==
// @name         Udemy — Media Key Controls
// @namespace    https://github.com/willcas36/userscripts
// @version      1.0.0
// @description  Controla el video de Udemy con las teclas multimedia: anterior/siguiente retroceden/avanzan 5s, play/pause togglean.
// @author       willcas36
// @match        https://www.udemy.com/course/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=udemy.com
// @grant        none
// @updateURL    https://raw.githubusercontent.com/willcas36/userscripts/main/udemy-media-keys/udemy-media-keys.user.js
// @downloadURL  https://raw.githubusercontent.com/willcas36/userscripts/main/udemy-media-keys/udemy-media-keys.user.js
// ==/UserScript==

(function () {
  'use strict';

  function rewind() {
    const v = document.querySelector('video');
    if (v) v.currentTime -= 5;
  }

  function forward() {
    const v = document.querySelector('video');
    if (v) v.currentTime += 5;
  }

  function playOrPause() {
    const el = document.querySelector(
      '[data-purpose="pause-button"], [data-purpose="play-button"]',
    );
    if (el) el.click(); // guard: el botón puede no existir todavía
  }

  if ('mediaSession' in navigator) {
    navigator.mediaSession.setActionHandler('previoustrack', rewind);
    navigator.mediaSession.setActionHandler('nexttrack', forward);
    navigator.mediaSession.setActionHandler('play', playOrPause);
    navigator.mediaSession.setActionHandler('pause', playOrPause);
  }
})();
