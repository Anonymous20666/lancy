"""Setup/idle membership tests with no Telegram connection."""
import asyncio,importlib.util,tempfile,types,unittest
from pathlib import Path
from unittest.mock import AsyncMock
SPEC=importlib.util.spec_from_file_location('patch_voice',Path(__file__).resolve().parents[1]/'main.py');MODULE=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(MODULE)
class SetupTests(unittest.IsolatedAsyncioTestCase):
 async def asyncSetUp(self):
  self.temp=tempfile.TemporaryDirectory();self.client=types.SimpleNamespace(get_me=AsyncMock(return_value=types.SimpleNamespace(id=55,is_bot=False)),stop=AsyncMock(),join_chat=AsyncMock(return_value=types.SimpleNamespace(id=-1)),leave_chat=AsyncMock(),invoke=AsyncMock());self.engine=types.SimpleNamespace(leave_call=AsyncMock(),time=AsyncMock(return_value=1))
  async def factory(alias,session):return self.client,self.engine,55
  self.bridge=MODULE.Bridge(self.temp.name,factory=factory);self.bridge.resolve_destination=AsyncMock();self.bridge.native_call=AsyncMock(return_value=(types.SimpleNamespace(),types.SimpleNamespace(id=1)))
  await self.bridge.register({'alias':'one','session':'offline','allowed':['-1','-2']})
 async def asyncTearDown(self):await self.bridge.shutdown();self.temp.cleanup()
 async def test_identity_reserves_only_an_approved_destination(self):
  result=await self.bridge.setup({'chat_id':-1,'stage':'identity'});self.assertEqual(result['user_id'],55);self.assertEqual(self.bridge.accounts['one']['leases'],{-1})
  await self.bridge.setup({'chat_id':-2,'stage':'identity'});self.assertEqual(self.bridge.accounts['one']['leases'],{-1,-2})
  with self.assertRaises(MODULE.VoiceFailure):await self.bridge.setup({'chat_id':-3,'stage':'identity'})
 async def test_failed_identity_does_not_leak_a_reservation(self):
  self.client.get_me.side_effect=RuntimeError('private-fixture-error')
  with self.assertRaises(RuntimeError):await self.bridge.setup({'chat_id':-1,'stage':'identity'})
  self.assertEqual(self.bridge.accounts['one']['leases'],set());self.assertNotIn(-1,self.bridge.prepared)
 async def test_join_rejects_arbitrary_urls_without_a_network_call(self):
  for value in ['https://evil.example/+foo','http://t.me/+fixture_invite','https://t.me/somegroup','https://t.me/+bad?x=y']:
   with self.assertRaises(MODULE.VoiceFailure):await self.bridge.setup({'chat_id':-1,'stage':'join','invite_link':value})
  self.client.join_chat.assert_not_awaited()
 async def test_join_verifies_destination_and_marks_cleanup(self):
  result=await self.bridge.setup({'chat_id':-1,'stage':'join','invite_link':'https://t.me/+fixture_invite'});self.assertTrue(result['ok']);self.assertIn(-1,self.bridge.accounts['one']['managed'])
 async def test_wrong_chat_join_is_not_accepted(self):
  self.client.join_chat.return_value=types.SimpleNamespace(id=-999)
  with self.assertRaises(MODULE.VoiceFailure):await self.bridge.setup({'chat_id':-1,'stage':'join','invite_link':'https://t.me/+fixture_invite'})
  self.assertNotIn(-1,self.bridge.accounts['one']['managed'])
 async def test_existing_call_is_reused_not_created(self):
  result=await self.bridge.setup({'chat_id':-1,'stage':'start','create':True});self.assertTrue(result['call_ready']);self.assertFalse(result['created']);self.client.invoke.assert_not_awaited()
 async def test_creation_requires_explicit_true_and_rechecks_native_state(self):
  with self.assertRaises(MODULE.VoiceFailure):await self.bridge.setup({'chat_id':-1,'stage':'start','create':False})
  self.bridge.native_call.side_effect=[(types.SimpleNamespace(),None),(types.SimpleNamespace(),types.SimpleNamespace(id=9))]
  result=await self.bridge.setup({'chat_id':-1,'stage':'start','create':True});self.assertTrue(result['created']);self.assertEqual(self.client.invoke.await_count,1)
  request=self.client.invoke.await_args.args[0];self.assertEqual(type(request).__name__,'CreateGroupCall')
 async def test_join_when_already_participant_succeeds_and_resolves_destination(self):
  self.bridge.auto_create_call_in_tests = True
  UserAlreadyParticipant = type('UserAlreadyParticipant', (Exception,), {})
  self.client.join_chat.side_effect = UserAlreadyParticipant()
  result = await self.bridge.setup({'chat_id': -1, 'stage': 'join', 'invite_link': 'https://t.me/+fixture_invite'})
  self.assertTrue(result['ok'])
  self.assertIn(-1, self.bridge.accounts['one']['managed'])
  self.bridge.resolve_destination.assert_awaited()
 async def test_play_auto_creates_group_call_when_native_call_is_none(self):
  self.bridge.auto_create_call_in_tests = True
  self.bridge.native_call = AsyncMock(side_effect=[(types.SimpleNamespace(), None), (types.SimpleNamespace(), types.SimpleNamespace(id=99))])
  self.bridge.stream = AsyncMock()
  f = Path(self.temp.name) / 'sample.mp3'; f.write_bytes(b'audio')
  result = await self.bridge.play({'chat_id': -1, 'stream_url': str(f), 'playback_id': 'auto-call-test'})
  self.assertTrue(result['ok'])
  self.assertEqual(self.client.invoke.await_count, 1)
  req = self.client.invoke.await_args.args[0]
  self.assertEqual(type(req).__name__, 'CreateGroupCall')
 async def test_play_replaces_track_in_place_without_leaving_active_call_and_recovers_after_hangup(self):
  self.bridge.auto_create_call_in_tests = True
  self.bridge.stream = AsyncMock()
  f = Path(self.temp.name) / 'sample.mp3'; f.write_bytes(b'audio')
  self.bridge.native_call = AsyncMock(return_value=(types.SimpleNamespace(), types.SimpleNamespace(id=77)))
  await self.bridge.play({'chat_id': -1, 'stream_url': str(f), 'playback_id': 'track-1'})
  self.engine.leave_call.reset_mock()
  await self.bridge.play({'chat_id': -1, 'stream_url': str(f), 'playback_id': 'track-2'})
  self.engine.leave_call.assert_not_awaited()
  # Simulate manual hangup (native_call returns None, then new call id=88 after CreateGroupCall)
  self.bridge.native_call = AsyncMock(side_effect=[(types.SimpleNamespace(), None), (types.SimpleNamespace(), types.SimpleNamespace(id=88))])
  await self.bridge.play({'chat_id': -1, 'stream_url': str(f), 'playback_id': 'track-3'})
  self.engine.leave_call.assert_awaited_once_with(-1)
  self.assertEqual(self.bridge.calls[-1]['native_call'].id, 88)
 def test_classify_handles_floodwait_and_rpc_groupcall_errors(self):
  FloodWait = type('FloodWait', (Exception,), {'value': 3})
  self.assertEqual(MODULE.classify(FloodWait()), 'RATE_LIMITED')
  rpc = Exception('GROUPCALL_ALREADY_DISCARDED')
  self.assertEqual(MODULE.classify(rpc), 'NO_ACTIVE_CALL')
  rpc_admin = Exception('CHAT_ADMIN_REQUIRED')
  self.assertEqual(MODULE.classify(rpc_admin), 'PERMISSION_DENIED')
 async def test_idle_prepared_group_can_leave_without_a_playback_call(self):
  await self.bridge.setup({'chat_id':-1,'stage':'manage'});await self.bridge.control('stop',{'chat_id':-1,'leave_membership':True});self.client.leave_chat.assert_awaited_once_with(-1,delete=False);self.assertEqual(self.bridge.accounts['one']['leases'],set());self.assertNotIn(-1,self.bridge.prepared)
 async def test_channel_call_only_departure_does_not_leave_membership(self):
  await self.bridge.setup({'chat_id':-1,'stage':'manage'});await self.bridge.control('stop',{'chat_id':-1,'leave_membership':False});self.client.leave_chat.assert_not_awaited()
 async def test_group_leave_failure_holds_reservation_for_retry(self):
  await self.bridge.setup({'chat_id':-1,'stage':'manage'});self.client.leave_chat.side_effect=RuntimeError('sensitive-fixture')
  with self.assertRaises(MODULE.VoiceFailure):await self.bridge.control('stop',{'chat_id':-1,'leave_membership':True})
  self.assertEqual(self.bridge.accounts['one']['leases'],{-1});self.assertIn(-1,self.bridge.prepared)
 async def test_cleanup_of_old_membership_does_not_release_another_live_destination(self):
  self.bridge.accounts['one']['managed'].add(-1);await self.bridge.setup({'chat_id':-2,'stage':'identity'});await self.bridge.control('stop',{'chat_id':-1,'leave_membership':True});self.assertEqual(self.bridge.accounts['one']['leases'],{-2})

 async def test_finished_setup_releases_only_the_short_preflight_reservation(self):
  await self.bridge.setup({'chat_id':-1,'stage':'identity'});await self.bridge.setup({'chat_id':-1,'stage':'start','create':True})
  self.assertEqual(self.bridge.accounts['one']['leases'],set());self.assertIn(-1,self.bridge.prepared)
  await self.bridge.setup({'chat_id':-2,'stage':'identity'})
  await self.bridge.setup({'chat_id':-1,'stage':'identity'})
  self.assertEqual(self.bridge.accounts['one']['leases'],{-1,-2})

 async def test_authenticated_end_event_channel_carries_only_scoped_playback_identity(self):
  from aiohttp.test_utils import TestClient,TestServer
  token='offline-'+('x'*40);client=TestClient(TestServer(MODULE.make_app(self.bridge,token)));await client.start_server()
  try:
   self.assertEqual((await client.get('/events')).status,401)
   self.bridge.events.put_nowait({'chat_id':-1,'playback_id':'fixture-source','status':'ended'})
   response=await client.get('/events',headers={'Authorization':'Bearer '+token});body=await response.json();self.assertEqual(body['events'][0]['playback_id'],'fixture-source');self.assertNotIn('session',str(body))
  finally:await client.close()
