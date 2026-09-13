// Linear-time replacement for rss-parser's internal utils.stripHtml, which it runs on
// every item's content to build `contentSnippet` — during parsing, unconditionally,
// whether or not that snippet is ever used.
//
// The original (rss-parser 3.13.0, lib/utils.js):
//   str.replace(/([^\n])<\/?(h|br|p|ul|ol|li|blockquote|section|table|tr|div)(?:.|\n)*?>([^\n])/gm, '$1\n$3')
//   str.replace(/<(?:.|\n)*?>/gm, '')
// Each `(?:.|\n)*?>` scans ahead for a ">". On content with many "<" and nothing that
// completes a match, every "<" rescans the remainder before failing, so the work grows
// with the square of the input: through the real parser, 100 KB of "<img " took 1.4 s
// and 400 KB took 23.8 s, while XML-parsing that same feed took ~2 ms. Node is
// single-threaded, so one hostile feed stalled the whole server on every refresh.
//
// Output is identical to the original's, quirks included, so no feed's snippets change
// (checked against a verbatim copy by a seeded differential test, and against real
// feeds). The original's matching rules, spelled out:
//   - `(?:.|\n)` matches any character EXCEPT \r, U+2028 and U+2029 (`.` excludes every
//     line terminator; `|\n` only adds \n back). Any of those three ends a match attempt.
//   - In pass 1 the lazy group doesn't stop at the first ">": if the character after a
//     ">" is "\n", or there isn't one, `([^\n])` fails and the group swallows that ">"
//     and keeps going. So the match ends at the first ">" that has a non-"\n" character
//     after it — possibly past other tags, consuming any text in between.
//   - Pass 2 has nothing after its ">", so it always ends at the first ">".
// Rather than rescanning, each "where's the next such character" question is answered by
// a cursor that only moves forward, which makes the total work linear.

const BLOCK_TAG_OPENING = /[^\n]<\/?(?:h|br|p|ul|ol|li|blockquote|section|table|tr|div)/g;
const GT_WITH_NON_NEWLINE_AFTER = />(?=[^\n])/g;
const GT = />/g;
const MATCH_STOPPER = /[\r\u2028\u2029]/g;

// Fresh instances per call, so no lastIndex state is shared between invocations.
const fresh = (pattern) => new RegExp(pattern.source, pattern.flags);

// Returns a function answering "index of the first match at or after `from`, or -1".
// Callers ask with non-decreasing `from`, so a previous answer stays valid until `from`
// moves past it, and the string is only ever scanned forward. (A smaller `from` still
// gets a correct answer, just via a rescan.)
function forwardFinder(pattern, str) {
  let answeredFrom = 0;
  let answer = null;
  return (from) => {
    if (answer !== null && from >= answeredFrom && (answer === -1 || from <= answer)) return answer;
    pattern.lastIndex = from;
    const match = pattern.exec(str);
    answeredFrom = from;
    answer = match ? match.index : -1;
    return answer;
  };
}

// Pass 1: X<blocktag ...>Y  ->  X\nY
function insertBlockBreaks(str) {
  const opening = fresh(BLOCK_TAG_OPENING);
  const nextGt = forwardFinder(fresh(GT_WITH_NON_NEWLINE_AFTER), str);
  const nextStopper = forwardFinder(fresh(MATCH_STOPPER), str);
  let out = "";
  let copiedUpTo = 0;
  let searchFrom = 0;
  for (;;) {
    opening.lastIndex = searchFrom;
    const match = opening.exec(str);
    if (!match) break;
    const start = match.index; // the character before "<"; "<" is at start + 1
    const gt = nextGt(start + 2);
    const stopper = nextStopper(start + 2);
    if (gt !== -1 && (stopper === -1 || gt < stopper)) {
      out += str.slice(copiedUpTo, start) + str[start] + "\n" + str[gt + 1];
      copiedUpTo = searchFrom = gt + 2;
    } else {
      searchFrom = start + 1; // no match can start here; the original retries one along
    }
  }
  return out + str.slice(copiedUpTo);
}

// Pass 2: remove every <...>
function removeTags(str) {
  const nextGt = forwardFinder(fresh(GT), str);
  const nextStopper = forwardFinder(fresh(MATCH_STOPPER), str);
  let out = "";
  let copiedUpTo = 0;
  let searchFrom = 0;
  for (;;) {
    const lt = str.indexOf("<", searchFrom);
    if (lt === -1) break;
    const gt = nextGt(lt + 1);
    const stopper = nextStopper(lt + 1);
    if (gt !== -1 && (stopper === -1 || gt < stopper)) {
      out += str.slice(copiedUpTo, lt);
      copiedUpTo = searchFrom = gt + 1;
    } else {
      searchFrom = lt + 1;
    }
  }
  return out + str.slice(copiedUpTo);
}

export function stripHtml(str) {
  return removeTags(insertBlockBreaks(str));
}
