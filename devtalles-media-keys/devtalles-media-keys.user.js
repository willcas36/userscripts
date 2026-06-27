// ==UserScript==
// @name         Dev Talles — Media Key Controls
// @namespace    https://github.com/willcas36/userscripts
// @version      1.0.0
// @description  Controla el reproductor Wistia de Dev Talles con las teclas multimedia: anterior/siguiente retroceden/avanzan 5s, play/pause.
// @author       willcas36
// @match        https://cursos.devtalles.com/api/course_player/*
// @grant        none
// @updateURL    https://raw.githubusercontent.com/willcas36/userscripts/main/devtalles-media-keys/devtalles-media-keys.user.js
// @downloadURL  https://raw.githubusercontent.com/willcas36/userscripts/main/devtalles-media-keys/devtalles-media-keys.user.js
// ==/UserScript==

(function () {
  'use strict';

  const waitForWistia = setInterval(() => {
    const el = document.querySelector('[class*="wistia_embed"]');
    if (!el) return;

    const match = el.className.match(/wistia_async_([a-z0-9]+)/);
    if (!match) return;

    const video = Wistia.api(match[1]);
    if (!video) return;

    console.log('🎬 Wistia video listo. Controles personalizados activados.');

    navigator.mediaSession.setActionHandler('previoustrack', () => {
      video.time(video.time() - 5);
    });
    navigator.mediaSession.setActionHandler('nexttrack', () => {
      video.time(video.time() + 5);
    });
    navigator.mediaSession.setActionHandler('play', () => {
      video.play();
    });
    navigator.mediaSession.setActionHandler('pause', () => {
      video.pause();
    });

    clearInterval(waitForWistia);
  }, 500);
})();
