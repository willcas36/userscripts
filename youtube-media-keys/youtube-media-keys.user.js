// ==UserScript==
// @name         YouTube — Media Key Controls
// @namespace    https://github.com/willcas36/userscripts
// @version      1.0.0
// @description  Controla el video de YouTube con las teclas multimedia: anterior/siguiente retroceden/avanzan 5s, play/pause togglean. Reaplica los handlers porque YouTube los pisa.
// @author       willcas36
// @match        https://www.youtube.com/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=youtube.com
// @grant        none
// @updateURL    https://raw.githubusercontent.com/willcas36/userscripts/main/youtube-media-keys/youtube-media-keys.user.js
// @downloadURL  https://raw.githubusercontent.com/willcas36/userscripts/main/youtube-media-keys/youtube-media-keys.user.js
// ==/UserScript==

(function () {
  'use strict';

  if (!('mediaSession' in navigator)) return;

  function setMediaSessionHandlers() {
    const video = document.querySelector('video');
    if (!video) return;

    try {
      navigator.mediaSession.setActionHandler('previoustrack', () => {
        video.currentTime -= 5;
      });
      navigator.mediaSession.setActionHandler('nexttrack', () => {
        video.currentTime += 5;
      });
      navigator.mediaSession.setActionHandler('play', () => {
        video.paused ? video.play() : video.pause();
      });
      navigator.mediaSession.setActionHandler('pause', () => {
        video.paused ? video.play() : video.pause();
      });
    } catch (error) {
      console.warn('No se pudieron asignar los controles multimedia:', error);
    }
  }

  // YouTube es una SPA y reemplaza el <video>/handlers al navegar, así que los reaplicamos
  // periódicamente. (El original logueaba en cada tick y spameaba la consola: removido.)
  setInterval(setMediaSessionHandlers, 500);
})();
