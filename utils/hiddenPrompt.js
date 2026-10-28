'use strict';

// Ask for a secret at a terminal without echoing it. It only works on a real
// terminal: a secret is never read from a pipe, an argument or the environment.

function readHidden(question, { input = process.stdin, output = process.stdout } = {}) {
  return new Promise((resolve, reject) => {
    if (!input.isTTY || typeof input.setRawMode !== 'function') {
      reject(new Error('This needs a terminal: run it directly in a shell, not through a pipe or a script.'));
      return;
    }
    let value = '';
    output.write(question);
    input.setEncoding('utf8');
    input.setRawMode(true);
    input.resume();

    const finish = (error, result) => {
      input.removeListener('data', onData);
      input.setRawMode(false);
      input.pause();
      output.write('\n');
      if (error) reject(error);
      else resolve(result);
    };
    function onData(chunk) {
      if (chunk.startsWith('\u001b')) return; // arrow keys and other escape sequences
      for (const character of chunk) {
        if (character === '\r' || character === '\n') return finish(null, value);
        if (character === '\u0003' || character === '\u0004') return finish(new Error('Cancelled.'));
        if (character === '\u007f' || character === '\b') value = Array.from(value).slice(0, -1).join('');
        else if (character >= ' ') value += character;
      }
    }
    input.on('data', onData);
  });
}

module.exports = { readHidden };
