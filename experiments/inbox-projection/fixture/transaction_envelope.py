"""Remove only standalone outer BEGIN/COMMIT statements, never quoted body text."""
import re

def normalize(sql: str) -> tuple[str, int]:
    out=[];start=0;i=0;quote=None;block=0;line=False;removed=0
    while i<len(sql):
        c=sql[i];n=sql[i:i+2]
        if line:
            if c=='\n':line=False
            i+=1;continue
        if block:
            if n=='/*':block+=1;i+=2
            elif n=='*/':block-=1;i+=2
            else:i+=1
            continue
        if quote:
            if quote.startswith('$'):
                if sql.startswith(quote,i):i+=len(quote);quote=None
                else:i+=1
            elif c==quote:
                if i+1<len(sql) and sql[i+1]==quote:i+=2
                else:quote=None;i+=1
            elif c=='\\' and quote=="'":i+=2
            else:i+=1
            continue
        if n=='--':line=True;i+=2;continue
        if n=='/*':block=1;i+=2;continue
        if c in "'\"":quote=c;i+=1;continue
        if c=='$':
            m=re.match(r'\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$',sql[i:])
            if m:quote=m.group();i+=len(quote);continue
        if c==';':
            chunk=sql[start:i+1]
            clean=re.sub(r'/\*.*?\*/|--[^\n]*','',chunk,flags=re.S).strip()
            if re.fullmatch(r'(BEGIN|COMMIT)\s*;',clean,re.I):
                out.append(re.sub(r'(?i)\b(begin|commit)\s*;\s*$', '', chunk));removed+=1
            elif re.match(r'(?i)(ROLLBACK|START\s+TRANSACTION|BEGIN\s+TRANSACTION|COMMIT\s+TRANSACTION)\b',clean):
                raise ValueError('Unsupported explicit transaction control; review migration manually')
            else:out.append(chunk)
            start=i+1
        i+=1
    if quote or block:raise ValueError('Unterminated SQL quoting/comment')
    out.append(sql[start:]);return ''.join(out),removed

if __name__=='__main__':
    x="BEGIN; CREATE FUNCTION f() RETURNS text AS $$ BEGIN RETURN 'commit;'; END; $$ LANGUAGE plpgsql; COMMIT;"
    y,n=normalize(x);assert n==2 and "RETURN 'commit;'" in y and 'END;' in y
    x="-- begin;\nSELECT 'BEGIN;', \"commit;\"; /* COMMIT; */"
    assert normalize(x)==(x,0)
    try:normalize('ROLLBACK;')
    except ValueError:pass
    else:raise AssertionError('rollback accepted')
    print('transaction-envelope tests passed')
