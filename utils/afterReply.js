'use strict';

// Run `work` once, shortly after the reply to this request is out. Used when the
// work will kill the process that is sending the reply (TaskServer restarting
// itself): the caller gets its answer first.
//
// Both 'finish' (the reply was handed to the socket) and 'close' (the socket
// closed, which can happen without 'finish' when the client hangs up early)
// count. Whichever comes first starts the timer; the other is ignored.
function afterReply(res, work, { delayMs = 100 } = {}) {
  let scheduled = false;
  const run = () => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(work, delayMs);
  };
  res.on('finish', run);
  res.on('close', run);
}

module.exports = { afterReply };
