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
