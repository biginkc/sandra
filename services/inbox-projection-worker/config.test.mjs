import {test} from 'node:test';
import assert from 'node:assert/strict';
import {databaseConfig,assertLogin} from './config.mjs';
const base={INBOX_PROJECTION_DATABASE_URL:'postgresql://projection:secret@db.example.com/postgres?sslmode=verify-full'};
test('production transport requires verified hostname and rejects TLS weakening/options',()=>{
 const actual=databaseConfig(base);assert.deepEqual(actual.ssl,{rejectUnauthorized:true,servername:'db.example.com'});assert.equal(new URL(actual.connectionString).search,'');
 for(const url of ['postgresql://p:s@localhost/db','postgresql://p:s@127.0.0.1/db','postgresql://p:s@[::1]/db','postgresql://p:s@127.1/db','postgresql://p:s@db.example.com/db?sslmode=require','postgresql://p:s@db.example.com/db?sslcert=x'])assert.throws(()=>databaseConfig({...base,INBOX_PROJECTION_DATABASE_URL:url}));
});
test('plaintext requires exact explicit marked-fixture configuration',()=>{
 const local={INBOX_PROJECTION_DATABASE_URL:'postgresql://p:s@127.0.0.1:5432/sandra_inbox_install_20260913',INBOX_PROJECTION_EXPECT_DATABASE:'sandra_inbox_install_20260913',INBOX_PROJECTION_OWNED_FIXTURE_PLAINTEXT:'true'};
 assert.equal(databaseConfig(local).ssl,false);
 for(const patch of [{INBOX_PROJECTION_OWNED_FIXTURE_PLAINTEXT:'false'},{INBOX_PROJECTION_EXPECT_DATABASE:'postgres'},{INBOX_PROJECTION_DATABASE_URL:'postgresql://p:s@localhost:5432/sandra_inbox_install_20260913'}])assert.throws(()=>databaseConfig({...local,...patch}));
});
test('owned HTTP fixture requires exact loopback port, database and pre-credential label guard',()=>{
 const local={INBOX_PROJECTION_DATABASE_URL:'postgresql://p:s@127.0.0.1:54322/postgres',INBOX_PROJECTION_EXPECT_DATABASE:'postgres',INBOX_PROJECTION_OWNED_FIXTURE_PLAINTEXT:'true',INBOX_PROJECTION_FIXTURE_MARKER:'sandra-inbox-http-owned-synthetic-20260917',INBOX_PROJECTION_FIXTURE_OWNER:'release-infra',INBOX_PROJECTION_FIXTURE_PURPOSE:'sandra-inbox-release-http',INBOX_PROJECTION_FIXTURE_LABELS_VERIFIED:'true'};
 assert.equal(databaseConfig(local).ssl,false);
 for(const patch of [{INBOX_PROJECTION_FIXTURE_MARKER:'wrong'},{INBOX_PROJECTION_FIXTURE_OWNER:'postgres'},{INBOX_PROJECTION_FIXTURE_PURPOSE:'shared'},{INBOX_PROJECTION_FIXTURE_LABELS_VERIFIED:'false'},{INBOX_PROJECTION_DATABASE_URL:'postgresql://p:s@127.0.0.1:5432/postgres'},{INBOX_PROJECTION_DATABASE_URL:'postgresql://p:s@127.0.0.1:54322/other'}])assert.throws(()=>databaseConfig({...local,...patch}));
});
test('session login must be limited even after SET ROLE',()=>{
 const row={role:'inbox_projection_worker',login:'dedicated_login',login_safe:true,only_projection_membership:true,no_direct_data:true,only_expected_definers:true};assert.doesNotThrow(()=>assertLogin(row));
 for(const key of ['login_safe','only_projection_membership','no_direct_data','only_expected_definers'])assert.throws(()=>assertLogin({...row,[key]:false}));
 assert.throws(()=>assertLogin({...row,login:'inbox_projection_worker'}));
});
