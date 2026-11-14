"""Offline tests. No Telegram authorization, calls, media, or credentials are used."""
import asyncio
import importlib.util
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch, AsyncMock
from aiohttp.test_utils import TestClient, TestServer
SPEC = importlib.util.spec_from_file_location('lancy_voice', Path(__file__).resolve().parents[1] / 'main.py')
MODULE = importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(MODULE)
Bridge, VoiceFailure, make_app = MODULE.Bridge, MODULE.VoiceFailure, MODULE.make_app

class FakeClient:
    async def get_me(self): return types.SimpleNamespace(id=1, is_bot=False)
    async def stop(self): pass
class FakeEngine:
    def __init__(self): self.position = 0; self.left = []; self.streams = []; self.fail_leave = False
    async def play(self, chat, stream, **kw): self.streams.append((chat, stream, kw))
    async def time(self, chat): return self.position
    async def pause(self, chat): return True
    async def resume(self, chat): return True
    async def change_volume_call(self, chat, volume): return None
    async def leave_call(self, chat):
        if self.fail_leave: raise RuntimeError('do-not-expose-a-secret')
        self.left.append(chat)

class TestBridge(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.root = Path(self.temp.name)
        self.engine = FakeEngine(); self.next_uid = 0
        async def factory(alias, session):
            self.next_uid += 1
            return FakeClient(), self.engine, self.next_uid
        self.bridge = Bridge(self.root, factory=factory)
        async def stream(a, chat, call): await asyncio.sleep(0.005)
        self.bridge.stream = stream
        self.file = self.root / 'track.mp3'; self.file.write_bytes(b'fixture')
        await self.bridge.register({'alias':'one', 'session':'fixture', 'allowed':['-1','-2']})
    async def asyncTearDown(self): await self.bridge.shutdown(); self.temp.cleanup()
    def body(self, chat=-1, playback='one'): return {'chat_id':chat, 'stream_url':str(self.file), 'playback_id':playback, 'duration_seconds':120}
    async def test_one_account_concurrently_serves_two_isolated_destinations(self):
        result = await asyncio.gather(self.bridge.play(self.body(-1, 'first')), self.bridge.play(self.body(-2, 'second')))
        self.assertTrue(all(r['ok'] for r in result))
        self.assertEqual(self.bridge.accounts['one']['leases'], {-1, -2})
        self.assertEqual(self.bridge.calls[-1]['playback_id'], 'first')
        self.assertEqual(self.bridge.calls[-2]['playback_id'], 'second')
        await self.bridge.control('pause', {'chat_id': -1})
        await self.bridge.control('volume', {'chat_id': -1, 'volume': 70})
        self.assertEqual(self.bridge.calls[-2]['status'], 'playing')
        self.assertNotIn('volume', self.bridge.calls[-2])
        await self.bridge.control('stop', {'chat_id': -1})
        self.assertEqual(self.bridge.accounts['one']['leases'], {-2})
        self.assertEqual(self.bridge.calls[-2]['playback_id'], 'second')
        self.assertEqual(self.engine.left, [-1])
    async def test_same_destination_dedup(self):
        await asyncio.gather(self.bridge.play(self.body()), self.bridge.play(self.body()))
        self.assertEqual(len(self.bridge.calls), 1)
        self.assertEqual(self.bridge.accounts['one']['leases'], {-1})
    async def test_two_accounts_two_destinations(self):
        await self.bridge.register({'alias':'two','session':'fixture2','allowed':['-2']})
        await asyncio.gather(self.bridge.play(self.body(-1)), self.bridge.play(self.body(-2)))
        self.assertEqual(len(self.bridge.calls), 2)
        self.assertNotEqual(self.bridge.calls[-1]['alias'], self.bridge.calls[-2]['alias'])
        await self.bridge.control('stop', {'chat_id':-1})
        self.assertIn(-2, self.bridge.calls)
    async def test_destination_allowlist_and_disabled(self):
        with self.assertRaises(VoiceFailure): await self.bridge.play(self.body(-3))
        await self.bridge.configure({'alias':'one','enabled':False})
        with self.assertRaises(VoiceFailure): await self.bridge.play(self.body())
    async def test_in_use_account_cannot_be_removed_but_can_serve_another_chat(self):
        await self.bridge.play(self.body())
        with self.assertRaises(VoiceFailure): await self.bridge.configure({'alias':'one','remove':True})
        await self.bridge.play(self.body(-2))
        self.assertEqual(self.bridge.accounts['one']['leases'], {-1,-2})
    async def test_release_only_after_confirmed_leave(self):
        await self.bridge.play(self.body()); self.engine.fail_leave = True
        with self.assertRaises(RuntimeError): await self.bridge.control('stop', {'chat_id':-1})
        self.assertEqual(self.bridge.accounts['one']['leases'], {-1})
        self.engine.fail_leave = False
        await self.bridge.control('stop', {'chat_id':-1})
        self.assertEqual(self.bridge.accounts['one']['leases'], set())
    async def test_clock_uses_native_seconds_not_wall_time(self):
        await self.bridge.play(self.body()); self.engine.position = 22
        status = await self.bridge.status(-1)
        self.assertEqual(status['info']['position_seconds'], 22)
        await self.bridge.control('pause', {'chat_id':-1})
        self.assertEqual((await self.bridge.status(-1))['info']['status'], 'paused')
    async def test_native_completion_contains_current_playback_id(self):
        await self.bridge.play(self.body(playback='unique-track')); self.engine.position = 120
        status = await self.bridge.status(-1)
        self.assertEqual(status['info']['status'], 'ended')
        self.assertEqual(status['info']['playback_id'], 'unique-track')
    async def test_unavailable_clock_never_fabricates_progress(self):
        async def fail(chat): raise RuntimeError('native disconnected')
        self.engine.time = fail
        await self.bridge.play(self.body())
        for _ in range(9):
            self.bridge.calls[-1]['retry_after'] = 0  # advance past bounded backoff without sleeping
            status = await self.bridge.status(-1)
        self.assertIsNone(status['info']['position_seconds'])
        self.assertEqual(status['info']['status'], 'error')
        self.assertEqual(self.bridge.calls[-1]['retries'], 2)
    async def test_account_status_does_not_expose_private_identity(self):
        public = str(self.bridge.public_accounts(-1))
        for forbidden in ['phone','session','fixture','uid','encrypted']: self.assertNotIn(forbidden, public)
    async def test_source_must_be_a_contained_regular_media_file(self):
        for value in ['https://example.com/a.mp3', '/etc/passwd', str(self.root), str(self.root / 'missing.mp3')]:
            with self.assertRaises(VoiceFailure): self.bridge.source(value)
        link = self.root / 'link.mp3'; link.symlink_to('/etc/passwd')
        with self.assertRaises(VoiceFailure): self.bridge.source(str(link))
    async def test_malformed_aliases_and_positive_p2p_destinations_rejected(self):
        for alias in ['../secret','two:three','UPPER','x'*25]:
            with self.assertRaises(VoiceFailure): await self.bridge.register({'alias':alias,'session':'fixture'})
        with self.assertRaises(VoiceFailure): await self.bridge.play(self.body(10))
    async def test_authentication_body_limits_and_safe_errors(self):
        token = 'test-only-' + 'x'*40
        client = TestClient(TestServer(make_app(self.bridge, token))); await client.start_server()
        try:
            self.assertEqual((await client.get('/health')).status, 401)
            headers = {'Authorization':f'Bearer {token}'}
            r = await client.get('/health', headers=headers); self.assertEqual((await r.json())['protocol'], 2)
            r = await client.post('/call/play', json={'chat_id':'bad'}, headers=headers); self.assertEqual(r.status, 400)
            await self.bridge.play(self.body()); self.engine.fail_leave = True
            r = await client.post('/call/stop', json={'chat_id':-1}, headers=headers)
            self.assertNotIn('do-not-expose-a-secret', await r.text())
            r = await client.post('/call/play', data='x'*40000, headers=headers); self.assertNotEqual(r.status, 200)
        finally:
            self.engine.fail_leave = False
            await client.close()
    async def test_missing_token_refuses_start(self):
        with self.assertRaises(RuntimeError): make_app(self.bridge, '')

class MediaContract(unittest.IsolatedAsyncioTestCase):
    async def test_explicit_audio_video_flags_and_no_autostart(self):
        class Flags: REQUIRED='required'; IGNORE='ignore'
        class Stream:
            Flags = None
            def __init__(self, path, **kw): self.path=path; self.kw=kw
        Stream.Flags = Flags
        class Config:
            def __init__(self, **kw): self.kw=kw
        fake_types = types.ModuleType('pytgcalls.types'); fake_types.MediaStream=Stream; fake_types.AudioQuality=types.SimpleNamespace(HIGH='48k-stereo'); fake_types.VideoQuality=types.SimpleNamespace(SD_360p='360p'); fake_types.GroupCallConfig=Config
        bridge=Bridge('/tmp'); engine=FakeEngine(); bridge.ensure_publisher=AsyncMock()
        base={'path':'fixture.mp4','offset':10.0,'bass':True,'video':True}
        with patch.dict(sys.modules, {'pytgcalls':types.ModuleType('pytgcalls'),'pytgcalls.types':fake_types}):
            await bridge.stream({'engine':engine}, -1, base)
            stream=engine.streams[-1][1]
            self.assertEqual(stream.kw['audio_flags'], 'required'); self.assertEqual(stream.kw['video_flags'], 'required')
            self.assertIn('alimiter', stream.kw['ffmpeg_parameters'])
            self.assertIn('volume=0.5011872336', stream.kw['ffmpeg_parameters'])
            self.assertNotIn('highpass', stream.kw['ffmpeg_parameters'])
            self.assertFalse(engine.streams[-1][2]['config'].kw['auto_start'])
            await bridge.stream({'engine':engine}, -1, {**base, 'video':False})
            self.assertEqual(engine.streams[-1][1].kw['video_flags'], 'ignore')
            await bridge.stream({'engine':engine}, -1, {**base, 'video':False, 'is_channel':True})
            self.assertEqual(engine.streams[-1][1].kw['video_flags'], 'required')
            self.assertEqual(bridge.ensure_publisher.await_count, 3)
            await bridge.stream({'engine':engine}, -1, {**base, 'status':'paused'})
            self.assertEqual(bridge.ensure_publisher.await_count, 3, 'Seeking a paused source must not force an unmute')

if __name__ == '__main__': unittest.main()

class DestinationResolutionTests(unittest.IsolatedAsyncioTestCase):
    async def test_string_session_hydrates_only_existing_bounded_dialogs(self):
        from types import SimpleNamespace
        PeerIdInvalid = type('PeerIdInvalid', (Exception,), {})
        class Client:
            def __init__(self): self.loaded = False; self.limit = None
            async def get_chat(self, chat):
                if not self.loaded: raise PeerIdInvalid()
                return SimpleNamespace(id=chat)
            async def get_dialogs(self, limit):
                self.limit = limit
                self.loaded = True
                yield SimpleNamespace(chat=SimpleNamespace(id=-100))
        with tempfile.TemporaryDirectory() as root:
            bridge = Bridge(root)
            client = Client()
            await bridge.resolve_destination(client, -100)
            self.assertEqual(client.limit, 500)

class ErrorClassificationTests(unittest.TestCase):
    def test_explicit_safe_failures_keep_their_actionable_codes(self):
        self.assertEqual(MODULE.classify(VoiceFailure('SESSION_NOT_READY')), 'SESSION_NOT_READY')

class NativeCallAbsenceTests(unittest.IsolatedAsyncioTestCase):
    body=TestBridge.body
    asyncSetUp=TestBridge.asyncSetUp
    asyncTearDown=TestBridge.asyncTearDown
    async def test_definitive_native_absence_clears_stale_call_and_releases_lease(self):
        await self.bridge.play(self.body())
        NotInCallError=type('NotInCallError',(Exception,),{})
        async def absent(*_):raise NotInCallError()
        self.engine.time=absent
        self.engine.leave_call=absent
        status=await self.bridge.status(-1)
        self.assertFalse(status['active'])
        self.assertNotIn(-1,self.bridge.calls)
        self.assertEqual(self.bridge.accounts['one']['leases'], set())


class PublisherVerificationTests(unittest.IsolatedAsyncioTestCase):
    def participant(self, muted=False, allowed=True):
        return types.SimpleNamespace(peer=types.SimpleNamespace(user_id=7), muted=muted, can_self_unmute=allowed, source=123, left=False)
    async def test_local_unmute_and_fresh_server_verification_are_required(self):
        bridge=Bridge('/tmp'); call={}; client=types.SimpleNamespace(invoke=AsyncMock()); engine=types.SimpleNamespace(unmute=AsyncMock())
        bridge.native_publisher=AsyncMock(side_effect=[('existing-call',self.participant(True)),('existing-call',self.participant())])
        await bridge.ensure_publisher({'client':client,'engine':engine,'uid':7},-100,call)
        engine.unmute.assert_awaited_once_with(-100);self.assertTrue(call['publisher_verified']);self.assertFalse(call['publisher_muted'])
        request=client.invoke.await_args.args[0];self.assertFalse(request.muted);self.assertEqual(type(request.participant).__name__,'InputPeerSelf')
    async def test_moderator_locked_mute_is_not_overridden(self):
        bridge=Bridge('/tmp');client=types.SimpleNamespace(invoke=AsyncMock());engine=types.SimpleNamespace(unmute=AsyncMock())
        bridge.native_publisher=AsyncMock(return_value=('existing-call',self.participant(True,False)))
        with self.assertRaises(VoiceFailure) as caught:await bridge.ensure_publisher({'client':client,'engine':engine,'uid':7},-100,{})
        self.assertEqual(caught.exception.code,'PERMISSION_DENIED');engine.unmute.assert_not_awaited();client.invoke.assert_not_awaited()
    async def test_remaining_muted_cannot_be_reported_as_playing(self):
        bridge=Bridge('/tmp');client=types.SimpleNamespace(invoke=AsyncMock());engine=types.SimpleNamespace(unmute=AsyncMock());call={}
        bridge.native_publisher=AsyncMock(return_value=('existing-call',self.participant(True)))
        with self.assertRaises(VoiceFailure):await bridge.ensure_publisher({'client':client,'engine':engine,'uid':7},-100,call)
        self.assertNotIn('publisher_verified',call)
    async def test_later_server_mute_is_reported_without_auto_unmute_or_recovery(self):
        bridge=Bridge('/tmp');engine=types.SimpleNamespace(unmute=AsyncMock(),time=AsyncMock(return_value=5));bridge.accounts['one']={'engine':engine}
        bridge.native_publisher=AsyncMock(return_value=('existing-call',self.participant(True)))
        bridge.calls[-100]={'alias':'one','status':'playing','native_call':'existing-call','publisher_check_after':0,'publisher_verified':True,'retries':0,'playback_id':'recording','position_seconds':5,'duration':120,'offset':0,'last_progress':MODULE.time.monotonic(),'clock_errors':0}
        result=await bridge.status(-100);self.assertEqual(result['info']['status'],'error');self.assertTrue(result['info']['publisher_muted']);self.assertFalse(result['info']['publisher_verified']);engine.unmute.assert_not_awaited()
    async def test_native_self_lookup_uses_minimal_self_only_rpc(self):
        from pyrogram import raw
        bridge=Bridge('/tmp');own=self.participant();client=types.SimpleNamespace(invoke=AsyncMock(return_value=types.SimpleNamespace(participants=[own])))
        existing=raw.types.InputGroupCall(id=1,access_hash=2);_,participant=await bridge.native_publisher({'client':client,'uid':7},-100,existing)
        self.assertIs(participant,own);request=client.invoke.await_args.args[0];self.assertEqual(request.limit,1);self.assertEqual(type(request.ids[0]).__name__,'InputPeerSelf')

    async def test_completed_recording_is_not_misclassified_as_moderator_mute(self):
        bridge=Bridge('/tmp');engine=types.SimpleNamespace(time=AsyncMock(return_value=120));bridge.accounts['one']={'engine':engine}
        bridge.native_publisher=AsyncMock(return_value=('existing-call',self.participant(True)))
        bridge.calls[-100]={'alias':'one','status':'playing','native_call':'existing-call','publisher_check_after':0,'publisher_verified':True,'retries':0,'playback_id':'recording','position_seconds':5,'duration':120,'offset':0,'last_progress':MODULE.time.monotonic(),'clock_errors':0}
        result=await bridge.status(-100);self.assertEqual(result['info']['status'],'ended');bridge.native_publisher.assert_not_awaited()
    async def test_already_unmuted_capture_does_not_repeat_native_transition(self):
        bridge=Bridge('/tmp');call={};client=types.SimpleNamespace(invoke=AsyncMock());binding=types.SimpleNamespace(get_state=AsyncMock(return_value=types.SimpleNamespace(muted=False)));engine=types.SimpleNamespace(unmute=AsyncMock(),_binding=binding)
        bridge.native_publisher=AsyncMock(return_value=('existing-call',self.participant()))
        await bridge.ensure_publisher({'client':client,'engine':engine,'uid':7},-100,call)
        binding.get_state.assert_awaited_once_with(-100);engine.unmute.assert_not_awaited();client.invoke.assert_not_awaited();self.assertTrue(call['publisher_verified'])
    async def test_publisher_api_failure_is_actionable_without_raw_exception_contents(self):
        bridge=Bridge('/tmp')
        async def failed():raise TimeoutError('sensitive-runtime-details')
        with self.assertRaises(VoiceFailure) as caught:await bridge.publisher_step(failed(),'self_participant')
        self.assertEqual(caught.exception.code,'PUBLISHER_UNVERIFIED');self.assertEqual(caught.exception.publisher_state,{'stage':'self_participant','kind':'TimeoutError'});self.assertNotIn('sensitive',str(caught.exception.publisher_state))

class ResumePublisherFailureTests(unittest.IsolatedAsyncioTestCase):
    body=TestBridge.body
    asyncSetUp=TestBridge.asyncSetUp
    asyncTearDown=TestBridge.asyncTearDown
    async def test_failed_resume_verification_repauses_without_false_playing_status(self):
        await self.bridge.play(self.body());await self.bridge.control('pause',{'chat_id':-1});self.engine.pause=AsyncMock()
        self.bridge.ensure_publisher=AsyncMock(side_effect=VoiceFailure('PERMISSION_DENIED'))
        with self.assertRaises(VoiceFailure):await self.bridge.control('resume',{'chat_id':-1})
        self.engine.pause.assert_awaited_once_with(-1);self.assertEqual(self.bridge.calls[-1]['status'],'paused')

class ConcurrentDestinationSafetyTests(unittest.IsolatedAsyncioTestCase):
    body=TestBridge.body
    asyncSetUp=TestBridge.asyncSetUp
    asyncTearDown=TestBridge.asyncTearDown
    async def test_public_status_does_not_mark_reusable_account_busy_or_leak_sibling_destinations(self):
        await asyncio.gather(self.bridge.play(self.body(-1,'first')),self.bridge.play(self.body(-2,'second')))
        owner=self.bridge.public_accounts()[0];scoped=self.bridge.public_accounts(-1)[0]
        self.assertEqual(owner['status'],'available');self.assertEqual(owner['active_calls'],2);self.assertEqual(owner['destinations'],[-2,-1])
        self.assertIsNone(scoped['destinations']);self.assertEqual(scoped['active_calls'],1)
    async def test_failure_or_failed_stop_in_one_chat_does_not_block_another_chat(self):
        await self.bridge.play(self.body());self.engine.fail_leave=True
        with self.assertRaises(RuntimeError):await self.bridge.control('stop',{'chat_id':-1})
        await self.bridge.play(self.body(-2,'second'))
        self.assertEqual(self.bridge.accounts['one']['leases'],{-1,-2});self.assertEqual(self.bridge.calls[-2]['status'],'playing')
        self.engine.fail_leave=False
    async def test_same_chat_cannot_switch_accounts_while_a_sibling_can_use_it(self):
        await self.bridge.register({'alias':'two','session':'fixture','allowed':['-1','-2']})
        await self.bridge.play({**self.body(-1),'account_alias':'one'})
        with self.assertRaises(VoiceFailure):await self.bridge.play({**self.body(-1,'replacement'),'account_alias':'two'})
        await self.bridge.play({**self.body(-2),'account_alias':'one'})
        self.assertEqual(self.bridge.calls[-2]['alias'],'one')
    async def test_existing_chat_authorization_is_rechecked_not_bypassed(self):
        await self.bridge.play(self.body());self.bridge.accounts['one']['allowed']=['-2']
        with self.assertRaises(VoiceFailure):await self.bridge.play(self.body(-1,'replacement'))
        await self.bridge.play(self.body(-2,'second'))
    async def test_prepared_destination_blocks_account_reconfiguration_even_without_a_live_lease(self):
        self.bridge.prepared[-1]={'alias':'one'}
        with self.assertRaises(VoiceFailure) as caught:await self.bridge.configure({'alias':'one','remove':True})
        self.assertEqual(caught.exception.code,'ACCOUNT_IN_USE')

class StreamSyncAndGeometryTests(unittest.IsolatedAsyncioTestCase):
    async def test_video_sync_locks_nightcore_tempo_and_computes_exact_geometry(self):
        self.assertEqual(MODULE.compute_target_video_size(1920, 1080, 1280, 720, True), (1280, 720))
        self.assertEqual(MODULE.compute_target_video_size(972, 720, 1280, 720, True), (972, 720))
        self.assertEqual(MODULE.compute_target_video_size(1920, 800, 1280, 720, True), (1280, 532))
        self.assertEqual(MODULE.compute_target_video_size(1080, 1920, 1280, 720, True), (404, 720))

        class Flags: REQUIRED='required'; IGNORE='ignore'
        class Stream:
            def __init__(self, path, **kw): self.path=path; self.kw=kw
        Stream.Flags = Flags
        class Config:
            def __init__(self, **kw): self.kw=kw
        fake_types = types.ModuleType('pytgcalls.types'); fake_types.MediaStream=Stream; fake_types.AudioQuality=types.SimpleNamespace(HIGH='48k-stereo'); fake_types.VideoQuality=types.SimpleNamespace(HD_720p='720p', SD_360p='360p'); fake_types.GroupCallConfig=Config
        bridge=Bridge('/tmp'); engine=FakeEngine(); bridge.ensure_publisher=AsyncMock()
        with patch.dict(sys.modules, {'pytgcalls':types.ModuleType('pytgcalls'),'pytgcalls.types':fake_types}):
            await bridge.stream({'engine':engine}, -1, {'path':'clip.mp4','offset':0.0,'bass':False,'eq':'nightcore','video':True})
            ff_video = engine.streams[-1][1].kw['ffmpeg_parameters']
            self.assertNotIn('asetrate', ff_video)
            self.assertNotIn('atempo', ff_video)
            self.assertNotIn('pad=1280:720', ff_video)
            self.assertIn('-sws_flags lanczos', ff_video)

            await bridge.stream({'engine':engine}, -1, {'path':'song.mp3','offset':0.0,'bass':False,'eq':'nightcore','video':False})
            ff_audio = engine.streams[-1][1].kw['ffmpeg_parameters']
            self.assertIn('aresample=48000,asetrate=48000*1.12,aresample=48000', ff_audio)

    async def test_rewrite_video_ffmpeg_command_consolidates_vf_and_maps_primary_stream(self):
        orig = "ffmpeg -reconnect 1 -i http://127.0.0.1:3055/movie-proxy/tok -sws_flags lanczos -v quiet -f rawvideo -r 30 -pix_fmt yuv420p -vf scale=906:528 pipe:1"
        rewritten = MODULE.rewrite_video_ffmpeg_command(
            orig,
            924,
            520,
            subtitle_path='/tmp/sub:test.srt',
            stream_index=0,
            video_count=2,
            is_image=False,
        )
        import shlex as _shlex
        parts = _shlex.split(rewritten)
        self.assertEqual(sum(1 for p in parts if p == '-vf'), 1)
        vf_val = parts[parts.index('-vf') + 1]
        self.assertIn('scale=924:520:flags=lanczos,setsar=1,', vf_val)
        self.assertIn('format=yuv420p', vf_val)
        self.assertIn('-map', parts)
        self.assertEqual(parts[parts.index('-map') + 1], '0:0')

    async def test_probe_video_stream_info_skips_attached_pic_cover(self):
        import json as _json
        payload = {
            'streams': [
                {'index': 0, 'codec_name': 'hevc', 'width': 924, 'height': 520, 'disposition': {'attached_pic': 0}},
                {'index': 4, 'codec_name': 'png', 'width': 906, 'height': 528, 'disposition': {'attached_pic': 1}},
            ]
        }
        fake_proc = types.SimpleNamespace(returncode=0, communicate=AsyncMock(return_value=(_json.dumps(payload).encode('utf-8'), b'')), kill=lambda: None)
        with patch.object(MODULE.asyncio, 'create_subprocess_exec', AsyncMock(return_value=fake_proc)):
            info = await MODULE.probe_video_stream_info('http://127.0.0.1:3055/movie-proxy/tok')
        self.assertEqual(info, {'width': 924, 'height': 520, 'stream_index': 0, 'video_count': 2, 'is_image': False})

    async def test_strip_reconnect_at_eof_preserves_midstream_reconnect_for_hls_proxy(self):
        audio_cmd = 'ffmpeg -reconnect 1 -reconnect_at_eof 1 -reconnect_streamed 1 -reconnect_delay_max 2 -i http://127.0.0.1:3055/movie-proxy/abcdef0123456789 -f s16le pipe:1'
        video_cmd = 'ffmpeg -reconnect 1 -reconnect_at_eof 1 -reconnect_streamed 1 -reconnect_delay_max 2 -i http://127.0.0.1:3055/movie-proxy/abcdef0123456789 -f rawvideo -r 30 -pix_fmt yuv420p pipe:1'
        stripped_audio = MODULE.strip_reconnect_at_eof(audio_cmd)
        rewritten_video = MODULE.rewrite_video_ffmpeg_command(video_cmd, 1280, 686)
        self.assertNotIn('-reconnect_at_eof', stripped_audio)
        self.assertIn('-reconnect_streamed 1', stripped_audio)
        self.assertNotIn('-reconnect_at_eof', rewritten_video)
        self.assertIn('scale=1280:686:flags=lanczos,setsar=1,format=yuv420p', rewritten_video)


class AvSyncAndSubtitleRegressionTests(unittest.IsolatedAsyncioTestCase):
    async def test_http_call_subtitle_route_registered_and_not_404(self):
        token = 'test-sub-route-' + 'x' * 32
        with tempfile.TemporaryDirectory() as tmp:
            bridge = Bridge(tmp)
            engine = FakeEngine()
            bridge.accounts['main'] = {
                'alias': 'main',
                'status': 'ready',
                'engine': engine,
                'client': types.SimpleNamespace(me=types.SimpleNamespace(id=1)),
                'group_grants': set(),
            }
            bridge.calls[-1] = {
                'alias': 'main',
                'status': 'idle',
                'path': str(Path(tmp) / 'movie.mp4'),
                'offset': 0.0,
                'video': True,
                'bass': False,
                'playback_id': 'pb-1',
            }
            client = TestClient(TestServer(make_app(bridge, token)))
            await client.start_server()
            try:
                res = await client.post(
                    '/call/subtitle',
                    json={'chat_id': -1, 'subtitle_path': None},
                    headers={'Authorization': f'Bearer {token}'},
                )
                self.assertEqual(res.status, 200)
                body = await res.json()
                self.assertTrue(body.get('ok'))
            finally:
                await client.close()

    def test_shift_subtitle_handles_bom_short_webvtt_timestamps_and_strips_tags(self):
        with tempfile.TemporaryDirectory() as tmp:
            vtt_path = Path(tmp) / 'subs.vtt'
            vtt_path.write_text(
                '\ufeffWEBVTT\nKind: captions\n\nNOTE ignore this block\n\n'
                '00:05.500 --> 00:09.000 align:start\n'
                '<i>First</i> {\\an8}line\n\n'
                '00:12.000 --> 00:15.250\n'
                'Second line\n',
                encoding='utf-8',
            )
            bridge = Bridge(tmp)
            shifted_path = bridge.shift_subtitle(str(vtt_path), 4.0, 'pb-bom')
            self.assertIsNotNone(shifted_path)
            shifted_text = Path(shifted_path).read_text(encoding='utf-8')
            self.assertIn('00:00:01,500 --> 00:00:05,000', shifted_text)
            self.assertIn('First line', shifted_text)
            self.assertNotIn('<i>', shifted_text)
            self.assertNotIn('{\\an8}', shifted_text)
            self.assertNotIn('WEBVTT', shifted_text)
            self.assertIn('00:00:08,000 --> 00:00:11,250', shifted_text)

    def test_rewrite_audio_and_video_sync_flags_and_strips_first_pts_zero(self):
        audio_cmd = (
            'ffmpeg -ss 12.5 -i http://127.0.0.1:3055/movie.mp4 '
            '-f s16le -ac 2 -ar 48000 -af aresample=48000:async=1:first_pts=0 pipe:1'
        )
        video_cmd = (
            'ffmpeg -ss 12.5 -i http://127.0.0.1:3055/movie.mp4 '
            '-f rawvideo -r 30 -pix_fmt yuv420p pipe:1'
        )
        rw_audio = MODULE.rewrite_audio_ffmpeg_command(
            audio_cmd,
            stream_index=2,
            audio_count=2,
            pre_seek=9.0,
            copyts=True,
            trim_start=12.5,
            normalize_pts=True,
            strip_first_pts_zero=True,
        )
        rw_video = MODULE.rewrite_video_ffmpeg_command(
            video_cmd,
            1280,
            720,
            stream_index=0,
            video_count=1,
            fps=30,
            trim_start=12.5,
            normalize_pts=True,
            pre_seek=9.0,
            copyts=True,
        )
        self.assertIn('-copyts', rw_audio)
        self.assertIn('-copyts', rw_video)
        self.assertIn('-ss 9.000', rw_audio)
        self.assertIn('-ss 9.000', rw_video)
        self.assertIn('-map 0:2', rw_audio)
        self.assertIn('atrim=start=12.500,asetpts=PTS-STARTPTS', rw_audio)
        self.assertNotIn(':first_pts=0', rw_audio)
        self.assertIn('trim=start=12.500,setpts=PTS-STARTPTS,fps=fps=30', rw_video)

    async def test_probe_selects_primary_audio_track_and_end_to_end_ffmpeg_av_sync(self):
        import shutil
        import subprocess
        if not shutil.which('ffmpeg') or not shutil.which('ffprobe'):
            self.skipTest('ffmpeg/ffprobe binary unavailable')

        with tempfile.TemporaryDirectory() as tmp:
            tmp_dir = Path(tmp)
            # 1. Multi-audio-track MKV (track 1 = commentary, track 2 = default eng) -> probe selects eng
            multi_mkv = tmp_dir / 'multi.mkv'
            mk_proc = subprocess.run(
                [
                    'ffmpeg', '-y',
                    '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=24',
                    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
                    '-f', 'lavfi', '-i', 'sine=frequency=880:duration=2',
                    '-map', '0:v:0', '-map', '1:a:0', '-map', '2:a:0',
                    '-metadata:s:a:0', 'language=spa', '-metadata:s:a:0', 'title=Director Commentary',
                    '-metadata:s:a:1', 'language=eng', '-metadata:s:a:1', 'title=English Main',
                    '-disposition:a:0', '0', '-disposition:a:1', 'default',
                    str(multi_mkv),
                ],
                capture_output=True,
                text=True,
            )
            self.assertEqual(mk_proc.returncode, 0, mk_proc.stderr)
            info = await MODULE.probe_media_stream_info(str(multi_mkv))
            self.assertEqual(info['audio_count'], 2)
            self.assertEqual(info['audio_stream_index'], 2)

            # 2. MPEG-TS with non-zero container start_time (10.0s) -> rewritten mic & cam stay synced
            src_ts = tmp_dir / 'offset.ts'
            ts_proc = subprocess.run(
                [
                    'ffmpeg', '-y',
                    '-f', 'lavfi', '-i', 'testsrc=duration=8:size=320x240:rate=24',
                    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=8',
                    '-output_ts_offset', '10.0',
                    '-c:v', 'mpeg2video', '-c:a', 'mp2',
                    str(src_ts),
                ],
                capture_output=True,
                text=True,
            )
            self.assertEqual(ts_proc.returncode, 0, ts_proc.stderr)
            ts_info = await MODULE.probe_media_stream_info(str(src_ts))
            common_start = max(ts_info['video_start_time'], ts_info['audio_start_time'])

            for seek_off in (0.0, 4.5):
                trim_at = common_start + seek_off
                pre_seek = max(0.0, seek_off - 4.0) if seek_off > 4.0 else 0.0
                out_pcm = tmp_dir / f'mic_{seek_off}.pcm'
                out_yuv = tmp_dir / f'cam_{seek_off}.yuv'

                base_a = f'ffmpeg -y -i {src_ts} -f s16le -ac 2 -ar 48000 -af aresample=48000:async=1:first_pts=0 pipe:1'
                base_v = f'ffmpeg -y -i {src_ts} -f rawvideo -r 30 -pix_fmt yuv420p pipe:1'
                cmd_a = MODULE.rewrite_audio_ffmpeg_command(
                    base_a,
                    pre_seek=pre_seek,
                    copyts=True,
                    trim_start=trim_at,
                    normalize_pts=True,
                    strip_first_pts_zero=True,
                ).replace('pipe:1', str(out_pcm))
                cmd_v = MODULE.rewrite_video_ffmpeg_command(
                    base_v,
                    320,
                    240,
                    fps=30,
                    pre_seek=pre_seek,
                    copyts=True,
                    trim_start=trim_at,
                    normalize_pts=True,
                ).replace('pipe:1', str(out_yuv))

                ra = subprocess.run(cmd_a, shell=True, capture_output=True, text=True)
                rv = subprocess.run(cmd_v, shell=True, capture_output=True, text=True)
                self.assertEqual(ra.returncode, 0, ra.stderr)
                self.assertEqual(rv.returncode, 0, rv.stderr)

                mic_dur = out_pcm.stat().st_size / (48000 * 2 * 2)
                cam_dur = (out_yuv.stat().st_size / (320 * 240 * 3 // 2)) / 30.0
                self.assertLess(abs(mic_dur - cam_dur), 0.12, f'offset={seek_off}: mic={mic_dur:.3f}s cam={cam_dur:.3f}s')


class RestartResumeTitleAndSeekTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.client = types.SimpleNamespace(
            get_me=AsyncMock(return_value=types.SimpleNamespace(id=55, is_bot=False)),
            stop=AsyncMock(),
            join_chat=AsyncMock(return_value=types.SimpleNamespace(id=-1)),
            leave_chat=AsyncMock(),
            invoke=AsyncMock(),
        )
        self.engine = types.SimpleNamespace(
            play=AsyncMock(),
            pause=AsyncMock(),
            resume=AsyncMock(),
            leave_call=AsyncMock(),
            time=AsyncMock(return_value=0),
            unmute=AsyncMock(),
        )
        async def factory(alias, session):
            return self.client, self.engine, 55
        self.bridge = Bridge(self.temp.name, factory=factory)
        self.bridge.resolve_destination = AsyncMock()
        self.bridge.native_call = AsyncMock(return_value=(types.SimpleNamespace(), types.SimpleNamespace(id=77, access_hash=888)))
        self.bridge.ensure_publisher = AsyncMock()
        await self.bridge.register({'alias': 'one', 'session': 'offline', 'allowed': ['-1']})

    async def asyncTearDown(self):
        await self.bridge.shutdown()
        self.temp.cleanup()

    async def test_vc_title_passed_on_create_and_edit_group_call_title(self):
        self.bridge.auto_create_call_in_tests = True
        self.bridge.edit_call_title_in_tests = True
        self.bridge.native_call = AsyncMock(side_effect=[
            (types.SimpleNamespace(), None),
            (types.SimpleNamespace(), types.SimpleNamespace(id=101, access_hash=202)),
            (types.SimpleNamespace(), types.SimpleNamespace(id=101, access_hash=202)),
        ])
        self.bridge.stream = AsyncMock()
        media = Path(self.temp.name) / 'movie.mp4'
        media.write_bytes(b'video')

        res = await self.bridge.play({
            'chat_id': -1,
            'stream_url': str(media),
            'playback_id': 'mv-1',
            'vc_title': 'Inception (2010)',
            'video': True,
        })
        self.assertTrue(res['ok'])
        create_req = self.client.invoke.await_args_list[0].args[0]
        self.assertEqual(type(create_req).__name__, 'CreateGroupCall')
        self.assertEqual(create_req.title, 'Inception (2010)')

        # Next track in existing call updates title via EditGroupCallTitle
        self.bridge.auto_create_call_in_tests = False
        self.client.invoke.reset_mock()
        res2 = await self.bridge.play({
            'chat_id': -1,
            'stream_url': str(media),
            'playback_id': 'mv-2',
            'vc_title': 'Interstellar (2014)',
            'video': True,
        })
        self.assertTrue(res2['ok'])
        edit_req = self.client.invoke.await_args.args[0]
        self.assertEqual(type(edit_req).__name__, 'EditGroupCallTitle')
        self.assertEqual(edit_req.title, 'Interstellar (2014)')

    async def test_start_seconds_and_unknown_duration_seek_with_unprobed_fallback(self):
        media = Path(self.temp.name) / 'sample.mp3'
        media.write_bytes(b'audio')
        captured_cmds = []
        orig_probe = MODULE.probe_media_stream_info
        MODULE.probe_media_stream_info = AsyncMock(return_value=None)
        try:
            async def fake_stream(a, chat, call):
                mic = types.SimpleNamespace(path=f'ffmpeg -y -i {media} -f s16le -ac 2 -ar 48000 pipe:1')
                cam = types.SimpleNamespace(path=f'ffmpeg -y -i {media} -f rawvideo -r 30 -pix_fmt yuv420p pipe:1', parameters=types.SimpleNamespace(frame_rate=30, width=1280, height=720))
                info = await MODULE.probe_media_stream_info(str(media))
                offset_val = float(call.get('offset') or 0.0)
                sync_pre_seek = offset_val if (offset_val > 0.05 and not info) else None
                mic.path = MODULE.rewrite_audio_ffmpeg_command(mic.path, pre_seek=sync_pre_seek, normalize_pts=bool(sync_pre_seek))
                cam.path = MODULE.rewrite_video_ffmpeg_command(cam.path, 1280, 720, fps=30, pre_seek=sync_pre_seek, normalize_pts=True)
                captured_cmds.append((mic.path, cam.path))

            self.bridge.stream = fake_stream
            res = await self.bridge.play({
                'chat_id': -1,
                'stream_url': str(media),
                'playback_id': 'resume-1',
                'duration_seconds': 0,
                'start_seconds': 325.5,
                'video': True,
            })
            self.assertEqual(res['position_seconds'], 325.5)
            self.assertEqual(self.bridge.calls[-1]['offset'], 325.5)
            self.assertEqual(self.bridge.calls[-1]['position_seconds'], 325.5)
            self.assertIn('-ss 325.500', captured_cmds[-1][0])
            self.assertIn('-ss 325.500', captured_cmds[-1][1])

            # Unknown duration (0) seek must still succeed and keep numeric position_seconds
            seek_res = await self.bridge.control('seek', {'chat_id': -1, 'seconds': 90})
            self.assertEqual(seek_res['position_seconds'], 90.0)
            self.assertEqual(self.bridge.calls[-1]['position_seconds'], 90.0)
            self.assertIn('-ss 90.000', captured_cmds[-1][0])
            self.assertIn('-ss 90.000', captured_cmds[-1][1])
        finally:
            MODULE.probe_media_stream_info = orig_probe

    async def test_call_ended_preserves_last_position_on_chat_update_and_no_active_call(self):
        self.bridge.stream = AsyncMock()
        media = Path(self.temp.name) / 'movie_call_end.mp4'
        media.write_bytes(b'video')

        res = await self.bridge.play({
            'chat_id': -1,
            'stream_url': str(media),
            'playback_id': 'ce-1',
            'duration_seconds': 3600,
            'start_seconds': 500,
            'video': True,
        })
        self.assertEqual(res['position_seconds'], 500)

        # Simulate elapsed playback and Pause sampling exact clock before call termination
        self.engine.time = AsyncMock(return_value=145.5)
        await self.bridge.control('pause', {'chat_id': -1})
        self.assertAlmostEqual(self.bridge.calls[-1]['last_known_position'], 645.5, places=1)

        # Simulate external call end (ChatUpdate LEFT_CALL)
        self.engine.time = AsyncMock(side_effect=RuntimeError('No active call'))
        closed_pos = await self.bridge.handle_chat_update(-1, 'CLOSED_VOICE_CHAT', expected_alias='one')
        self.assertAlmostEqual(closed_pos, 645.5, places=1)
        self.assertNotIn(-1, self.bridge.calls)

        ev = self.bridge.events.get_nowait()
        self.assertEqual(ev['status'], 'call_ended')
        self.assertAlmostEqual(ev['position_seconds'], 645.5, places=1)

        st = await self.bridge.status(-1)
        self.assertFalse(st['active'])
        self.assertAlmostEqual(st['last_position_seconds'], 645.5, places=1)

        # Resuming via play() clears last_ended_positions and starts at start_seconds
        await self.bridge.play({
            'chat_id': -1,
            'stream_url': str(media),
            'playback_id': 'ce-2',
            'duration_seconds': 3600,
            'start_seconds': st['last_position_seconds'],
            'video': True,
        })
        self.assertNotIn(-1, self.bridge.last_ended_positions)
        self.assertAlmostEqual(self.bridge.calls[-1]['offset'], 645.5, places=1)

    async def test_remote_proxy_accepts_dash_mpd_hls_and_mp4_extensions_and_rejects_untrusted_urls(self):
        self.bridge.stream = AsyncMock()
        token = '0123456789abcdef0123456789abcdef'
        for ext in ('', '.mpd', '.m3u8', '.mp4'):
            url = f'http://127.0.0.1:41234/movie-proxy/{token}{ext}'
            res = await self.bridge.play({
                'chat_id': -1,
                'stream_url': url,
                'remote_proxy': True,
                'playback_id': f'proxy{ext or "-bare"}',
                'duration_seconds': 3697,
                'video': True,
            })
            self.assertTrue(res['ok'])
            self.assertTrue(self.bridge.calls[-1]['remote_proxy'])
            self.assertEqual(self.bridge.calls[-1]['path'], url)

        for bad_url, rp in [
            (f'http://127.0.0.1:41234/movie-proxy/{token}.mpd', False),
            (f'http://127.0.0.1:41234/movie-proxy/{token}.exe', True),
            (f'http://10.0.0.5:41234/movie-proxy/{token}.mpd', True),
            (f'http://127.0.0.1:41234/other/{token}.mpd', True),
        ]:
            with self.assertRaises(MODULE.VoiceFailure) as ctx:
                self.bridge.resolve_media_input({'stream_url': bad_url, 'remote_proxy': rp})
            self.assertEqual(ctx.exception.code, 'MEDIA_INVALID')

        NoVideoSourceFound = type('NoVideoSourceFound', (Exception,), {})
        NoAudioSourceFound = type('NoAudioSourceFound', (Exception,), {})
        self.assertEqual(MODULE.classify(NoVideoSourceFound('no video')), 'MEDIA_INVALID')
        self.assertEqual(MODULE.classify(NoAudioSourceFound('no audio')), 'MEDIA_INVALID')


class ChannelAuthSubSyncAndCallInviteTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.engine = FakeEngine()
        self.invoked = []

        class _InvokeClient(FakeClient):
            def __init__(self, owner):
                self.owner = owner

            async def invoke(self, req, **_kwargs):
                self.owner.invoked.append(req)
                name = type(req).__name__
                if name == 'GetGroupCall':
                    link = self.owner.get_call_link
                    return types.SimpleNamespace(call=types.SimpleNamespace(invite_link=link))
                if name == 'ExportGroupCallInvite':
                    return types.SimpleNamespace(link=self.owner.export_call_link)
                return types.SimpleNamespace()

        self.get_call_link = 'https://t.me/publicchan?livestream=live123'
        self.export_call_link = 'https://t.me/+privinvite?voicechat=vc789'
        self.client = _InvokeClient(self)

        async def factory(_alias, _session):
            return self.client, self.engine, 77

        self.bridge = Bridge(self.root, factory=factory)
        self.bridge.resolve_call_invite_in_tests = True
        self.stream_calls = []

        async def fake_stream(a, chat, call):
            self.stream_calls.append((chat, call.get('subtitle_path'), call.get('subtitle_offset')))
            await asyncio.sleep(0.002)

        self.bridge.stream = fake_stream
        self.media = self.root / 'movie.mp4'
        self.media.write_bytes(b'video')
        await self.bridge.register({'alias': 'one', 'session': 'fixture', 'allowed': ['-1001']})

    async def asyncTearDown(self):
        await self.bridge.shutdown()
        self.temp.cleanup()

    async def test_shift_subtitle_signed_offset_and_prune(self):
        vtt = self.root / 'sample.vtt'
        vtt.write_text(
            'WEBVTT\n\n'
            '00:00:10.000 --> 00:00:12.000\nLine A\n\n'
            '00:00:25.000 --> 00:00:27.000\nLine B\n',
            encoding='utf-8',
        )
        early_path = Path(self.bridge.shift_subtitle(str(vtt), 0.0, 'pb-early', subtitle_offset=-2.0))
        early_txt = early_path.read_text(encoding='utf-8')
        self.assertIn('00:00:08,000 --> 00:00:10,000', early_txt)

        late_path = Path(self.bridge.shift_subtitle(str(vtt), 10.0, 'pb-late', subtitle_offset=2.0))
        late_txt = late_path.read_text(encoding='utf-8')
        self.assertIn('00:00:02,000 --> 00:00:04,000', late_txt)

        srt = self.root / 'sub.srt'
        srt.write_text('1\n00:00:05,000 --> 00:00:07,000\nSubtle\n', encoding='utf-8')
        small_path = Path(self.bridge.shift_subtitle(str(srt), 0.0, 'pb-small', subtitle_offset=0.25))
        self.assertNotEqual(str(small_path), str(srt))
        self.assertIn('00:00:05,250 --> 00:00:07,250', small_path.read_text(encoding='utf-8'))

        self.bridge.calls[-1001] = {'playback_id': 'pb-early'}
        self.bridge.prune_shifted_subtitles(active_playback_id='pb-early')
        self.bridge.calls.pop(-1001, None)
        self.assertTrue(early_path.exists())
        self.assertFalse(late_path.exists())

    async def test_control_subtitle_offset_reloads_stream(self):
        srt = self.root / 'sync.srt'
        srt.write_text('1\n00:00:10,000 --> 00:00:12,000\nDialog\n', encoding='utf-8')
        res = await self.bridge.play({
            'chat_id': -1001,
            'stream_url': str(self.media),
            'playback_id': 'pb-sync',
            'duration_seconds': 300,
            'subtitle_path': str(srt),
            'subtitle_offset': 0.0,
        })
        self.assertTrue(res['ok'])
        prior_count = len(self.stream_calls)
        await self.bridge.control('subtitle', {
            'chat_id': -1001,
            'subtitle_path': str(srt),
            'subtitle_offset': -1.5,
        })
        self.assertEqual(len(self.stream_calls), prior_count + 1)
        self.assertEqual(self.bridge.calls[-1001]['subtitle_offset'], -1.5)
        st = await self.bridge.status(-1001)
        self.assertEqual(st['info']['subtitle_offset'], -1.5)

    async def test_resolve_call_invite_link_and_http_endpoint(self):
        native_call = types.SimpleNamespace(id=555001, access_hash=999002)
        acct = {'client': self.client, 'alias': 'one'}
        link1 = await self.bridge.resolve_call_invite_link(acct, native_call)
        self.assertEqual(link1, 'https://t.me/publicchan?livestream=live123')

        self.get_call_link = None
        link2 = await self.bridge.resolve_call_invite_link(acct, native_call)
        self.assertEqual(link2, 'https://t.me/+privinvite?voicechat=vc789')

        token = 'a' * 40
        app = make_app(self.bridge, token)
        self.bridge.calls[-1001] = {
            'alias': 'one',
            'status': 'playing',
            'playback_id': 'pb-link',
            'native_call': native_call,
            'call_invite_link': None,
        }
        async with TestClient(TestServer(app)) as cli:
            resp = await cli.get(
                '/call/invite-link?chat_id=-1001',
                headers={'Authorization': f'Bearer {token}'},
            )
            self.assertEqual(resp.status, 200)
            payload = await resp.json()
            self.assertTrue(payload['ok'])
            self.assertEqual(payload['call_invite_link'], 'https://t.me/+privinvite?voicechat=vc789')
