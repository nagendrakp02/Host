// JavaScript Document

var init = function () {
  "use strict";

  if (navigator.appVersion.indexOf("Win") != -1) {
    document.getElementById("container").classList.add("windows");
  }

  if (navigator.userAgent.indexOf("Trident") != -1) {
    document.getElementById("container").classList.add("ie");
  }

  if (window.navigator.userAgent.indexOf("Mac") != -1) {
    if (window.navigator.userAgent.indexOf("Firefox") != -1) {
      document.getElementById("container").className += "macFir";
    }
  }

  // VARIABLE DECLARATION
  var animCount = 0;
  var animTimer = setInterval(function () {
      theTimer();
    }, 100),
//    eyebrow = document.getElementById("eyebrow"),
    f1_copy = document.getElementById("f1_copy"),
    f2_copy = document.getElementById("f2_copy"),
    f3_copy = document.getElementById("f3_copy"),
    f3_copy1 = document.getElementById("f3_copy1"),
//    f3_footnote = document.getElementById("f3_footnote"),
//    f4_copy = document.getElementById("f4_copy"),
//    top_bar = document.getElementById("top_bar"),
//    bg1 = document.getElementById('bg1'),
//    logo = document.getElementById("logo"),
//    f4_logo = document.getElementById("f4_logo"),
//    cta = document.getElementById("cta"),
//	  cta_clickTag = document.getElementById("cta_clickTag"),
    cScrollbar;

  // ANIMATION
  function theTimer() {
    var scrollPosition;


    var userAgent = navigator.userAgent;


    if (userAgent.indexOf("Edge") > -1) {
      scrollPosition = -913;
    }

    else if (userAgent.indexOf("Firefox") > -1) {
      scrollPosition = -913; 
    }

    else if (userAgent.indexOf("Chrome") > -1) {
      scrollPosition = -930; 
    }

    else if (userAgent.indexOf("Safari") > -1) {
      scrollPosition = -913; 
    }
    else {
      scrollPosition = -913;
    }
    
    if (animCount == 10) {
      f1_copy.setAttribute("class", "fadeIn transition-1");

    } else if (animCount == 25) {
//      eyebrow.setAttribute("class", "fadeOut");
      f1_copy.setAttribute("class", "fadeOut");

    } else if (animCount == 30) {
      f2_copy.setAttribute("class", "fadeIn transition-1");

    } else if (animCount == 55) {
      f2_copy.setAttribute("class", "fadeOut");

    } else if (animCount == 60) {
      f3_copy.setAttribute("class", "fadeIn transition-1");

    } else if (animCount == 85) {
		f3_copy.setAttribute("class", "fadeOut");
		
    } else if (animCount == 90) {
		f3_copy1.setAttribute("class", "fadeIn transition-1");
		
    }  else if (animCount == 100) {
      cScrollbar.scrollTo(0, scrollPosition, 80000, cScrollbar.options.linearEasing);

    } else if (animCount == 110) {
      clearInterval(animTimer);
    }
    animCount++;
  }

  // EVENT LISTENER
  function createScrollBar() {
    var isDevice = false;
    if (
      /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
        navigator.userAgent
      )
    ) {
      isDevice = true;
    }
    (cScrollbar = new IScroll(scrollableContent, {
      scrollbars: "custom",
      mouseWheel: !0,
      click: isDevice,
      resizeScrollbars: false,
      linearEasing: {
        style: "cubic-bezier(0,0,1,1)",
        fn: function (k) {
          return k;
        },
      },
      interactiveScrollbars: !0,
      shrinkScrollbars: "scale",
    })),
      setTimeout(function () {
        cScrollbar.refresh();
      }, 500);
  }

  createScrollBar();
};

window.onload = function () {
  init();
};
