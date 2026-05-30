$(document).ready(function () {
  $('#loader_main_id').css({
    opacity: 0,
  });

  function hideLoader() {
    if ($('#problem_id').length) {
      $('#problem_id').animate({ opacity: 0 });
    }
    if ($('#by_who_id').length) {
      $('#by_who_id').animate({ opacity: 0 });
    }
    $('#loader_cont_id').animate({ opacity: 0 }, 600, function () {
      $('#loader_cont_id').css({
        zIndex: -2,
        visibility: 'hidden',
      });
    });
  }

  if ($('#problem_id').length) {
    $('#problem_id').animate(
      { margin: '0px 0px 0px 0px' },
      1000,
      function () { hideLoader(); }
    );
  } else {
    // No problem/by_who elements (e.g. invitation page) — hide loader directly
    hideLoader();
  }
});

// Hide for 5 sec
let fife_seconts_after = 5;
let seconts_now = 0;
let open_up_panel_rol = 0;
let interval = setInterval (look_up, 1000);
function look_up () {
  seconts_now++;
  if (fife_seconts_after === seconts_now) {
    fife_seconts_after = seconts_now + 5;
    close_header ();
  }
}
// Ends


$(document).ready(function(){
  $("#header_id").mouseover(function(){
    open_header ();
  });
});


function controler_for_opens () {
  if (open_up_panel_rol == 0) {
    close_header ();
    console.log('close');
  } else if (open_up_panel_rol == 1) {
    open_header ();
    console.log('open');
  }
}

function close_header () {
  $ ('#main_id_cont').css ({
    marginTop: '-25px',
  });
  $ ('#cont_ani_imp').css ({
    marginTop: '-50px', 
  });
  $ ('#cont_ani_imp2').css ({
    marginTop: '-50px',
  });
  $ ('#header_id').css ({
    marginTop: '-25px',
  });
  open_up_panel_rol = 1;
}

function open_header () {
  $ ('#main_id_cont').css ({
    marginTop: '0px',
  });
  $ ('#cont_ani_imp').css ({
    marginTop: '0px',
  });
  $ ('#cont_ani_imp2').css ({
    marginTop: '0px',
  });
  $ ('#header_id').css ({
    marginTop: '0px',
  });
  fife_seconts_after = seconts_now + 5;
  open_up_panel_rol = 0;
}

$ (document)
  .keydown (function (e) {
    if (e.ctrlKey) {
      ctrlPressed = true;
    }
  })
  .keyup (function (e) {
    if (e.ctrlKey) {
      ctrlPressed = false;
    }
  });

$ (document).keydown (function (e) {
  if (e.key == 'z') {
    if (ctrlPressed == true) {
      controler_for_opens ();
      ctrlPressed = false;
    }
  }
});
