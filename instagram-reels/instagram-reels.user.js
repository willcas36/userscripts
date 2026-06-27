// ==UserScript==
// @name         Instagram Reels — Unmute & Play
// @namespace    https://github.com/willcas36/userscripts
// @version      1.0.0
// @description  Al hacer click en un reel de Instagram, le saca el silencio y lo reproduce.
// @author       willcas36
// @match        https://www.instagram.com/reel/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=instagram.com
// @grant        none
// @updateURL    https://raw.githubusercontent.com/willcas36/userscripts/main/instagram-reels/instagram-reels.user.js
// @downloadURL  https://raw.githubusercontent.com/willcas36/userscripts/main/instagram-reels/instagram-reels.user.js
// ==/UserScript==

(function () {
  'use strict';

  // Cada click desmutea y reproduce el reel actual.
  // (El original usaba `{ twice: true }`, que NO es una opción válida de addEventListener
  //  y se ignoraba silenciosamente; el efecto real siempre fue "en cada click".)
  document.addEventListener('click', function () {
    const video = document.querySelector('video');
    if (video) {
      video.muted = false;
      video.play();
    }
  });
})();
