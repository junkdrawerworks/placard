#!/usr/bin/env python3
"""Placard's lines for the Dispatch morning slip: the house manual's regular jobs that are due.

  python3 placard_slip.py URL     prints the lines (32 characters wide, for a 58 mm printer), or (nothing due), or a
                                  line starting Ledger: when it can't read the manual (a wrong address), and exits 1

URL is the ledger's /exec address, the one in Placard's js/config.js. It reads the manual as a tenant's phone does,
with no key.

From Dispatch's own code:  from placard_slip import due_lines;  lines = due_lines(url)
It returns [] when nothing is due, and never raises: a slip prints even if the ledger is down. It gives up after about
25 seconds. A page is due once its Last done date and "every N months" (both set on the page in Placard) have come
round, the same day Placard's Edit list shows its due chip: Last done Aug 31 and every 6 months is due Feb 28."""
import calendar, datetime, json, re, socket, sys, textwrap, threading, time, urllib.error, urllib.parse, urllib.request

DEADLINE = 25   # seconds for the whole read, so a slow ledger can't hold up the slip

def read(url, deadline=DEADLINE):
    """The manual's pages, as a tenant's phone gets them (op pub), within the deadline; raises on any failure."""
    box = {}
    def go():
        try:
            q = urllib.parse.urlencode({'op': 'pub', 'app': 'placard', 'coll': 'site'})
            with urllib.request.urlopen(url + ('&' if '?' in url else '?') + q, timeout=deadline) as r:   # follows Google's redirect
                j = json.load(r)
            if not j.get('ok'): raise RuntimeError(j.get('error') or 'it said no')
            box['docs'] = [d for d in j.get('docs') or [] if isinstance(d, dict) and not d.get('_deleted')]
        except BaseException as e:
            box['error'] = e
    t = threading.Thread(target=go, daemon=True)
    t.start(); t.join(deadline)
    if 'error' in box: raise box['error']
    if 'docs' not in box: raise TimeoutError(f'no answer in {deadline} s')
    return box['docs']

DAY = re.compile(r'([12][0-9]{3})-([0-9]{2})-([0-9]{2})')
def last_done(p):
    """A page's Last done as starter.js's isoDay() reads it (YYYY-MM-DD, a real day of a year from 1000), or None."""
    m = DAY.fullmatch(p.get('lastDone') if isinstance(p.get('lastDone'), str) else '')
    if not m: return None
    y, mo, d = int(m[1]), int(m[2]), int(m[3])
    return datetime.date(y, mo, d) if 1 <= mo <= 12 and 1 <= d <= calendar.monthrange(y, mo)[1] else None

def every(p):
    """Every N months as starter.js's everyOf() reads it: a whole number from 1 to 120, a number or digits ('3'); 0 else."""
    v = p.get('every')
    if isinstance(v, bool): return 0
    if isinstance(v, (int, float)): n = v
    elif isinstance(v, str) and re.fullmatch(r'\s*[0-9]+(?:\.0*)?\s*', v): n = float(v)
    else: return 0
    return int(n) if n == int(n) and 1 <= n <= 120 else 0

def next_due(p):
    """When a page's regular job is next due, as starter.js's nextDue() works it out: Last done plus every N months,
    the day kept or the month's last day (Aug 31 and 6 months is Feb 28). None when either is missing or unreadable."""
    n, last = every(p), last_done(p)
    if not n or not last: return None
    y, mo, d = last.year, last.month, last.day
    k = mo - 1 + n
    y, mo = y + k // 12, k % 12 + 1
    return datetime.date(y, mo, min(d, calendar.monthrange(y, mo)[1]))

MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
def short(day, today):
    return f'{MON[day.month - 1]} {day.day}' + ('' if day.year == today.year else f', {day.year}')

def job(task):
    """'Filter change' as it reads mid-sentence: 'filter change' (but 'HVAC service' stays)."""
    t = ' '.join(task.split()) if isinstance(task, str) else ''
    return t[0].lower() + t[1:] if len(t) > 1 and t[1].islower() else t

NB = '\xa0'   # a space the wrap won't break at
def wrap(text, width):
    return [l.replace(NB, ' ') for l in textwrap.wrap(text, width, subsequent_indent='  ', break_on_hyphens=False)]

def due(docs, today):
    """(name, task, last, due) for each page whose job is due, the longest overdue first. The front page and a deleted
    page's sticker record are not pages."""
    out = []
    for p in docs:
        if p.get('id') in ('house', 'home') or p.get('to'): continue
        when = next_due(p)
        if when and when <= today:
            name = ' '.join(str(p.get('name') or p.get('id') or '').split())
            out.append((name, job(p.get('task')), last_done(p), when))
    return sorted(out, key=lambda r: (r[3], r[0]))

def slip(docs, width=32, today=None):
    """The slip's lines from the pages: 'Rental: <page> - <job> due (last <day>)' for each, wrapped, or []."""
    today = today or datetime.date.today()
    out = []
    for name, task, last, _ in due(docs, today):
        what = f'{name} - {task}' if task else name
        out += wrap(f'Rental: {what} due (last {short(last, today).replace(" ", NB)})', width)
    return out

def due_lines(url, width=32, today=None, deadline=DEADLINE):
    try:
        return slip(read(url, deadline), width=width, today=today)
    except Exception:
        return []

def why(e):
    """What went wrong reading the manual, in a few words for the Ledger: line."""
    if isinstance(e, RuntimeError): return str(e)
    if isinstance(e, urllib.error.HTTPError): return f"couldn't reach it (HTTP {e.code})"
    if isinstance(e, urllib.error.URLError): return f"couldn't reach it ({e.reason})"
    if isinstance(e, (TimeoutError, socket.timeout)): return f"couldn't reach it ({e or 'timed out'})"
    if isinstance(e, ValueError): return 'got a web page, not the ledger (check the address ends /exec and access is Anyone)'
    return f"couldn't reach it ({e})"

if __name__ == '__main__':
    if len(sys.argv) != 2: sys.exit(__doc__)
    try:
        docs = read(sys.argv[1])
    except Exception as e:
        print('Ledger: ' + why(e)); sys.exit(1)
    print('\n'.join(slip(docs)) or '(nothing due)')
