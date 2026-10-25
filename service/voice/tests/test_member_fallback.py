"""Owner-opt-in, existing-member-only group fallback; all tests offline."""
import importlib.util,tempfile,types,unittest
from pathlib import Path
from unittest.mock import AsyncMock
SPEC=importlib.util.spec_from_file_location('member_voice',Path(__file__).resolve().parents[1]/'main.py');M=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(M)
class ExistingMemberTests(unittest.IsolatedAsyncioTestCase):
 async def asyncSetUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.file=Path(self.tmp.name)/'x.mp3';self.file.write_bytes(b'fixture')
  self.client=types.SimpleNamespace(get_me=AsyncMock(return_value=types.SimpleNamespace(id=55,is_bot=False)),get_chat=AsyncMock(return_value=types.SimpleNamespace(type='supergroup')),get_chat_member=AsyncMock(return_value=types.SimpleNamespace(status='administrator')),join_chat=AsyncMock(),leave_chat=AsyncMock(),stop=AsyncMock())
  self.engine=types.SimpleNamespace(leave_call=AsyncMock(),time=AsyncMock(return_value=1))
  async def factory(*args):return self.client,self.engine,55
  self.b=M.Bridge(self.tmp.name,factory=factory);self.b.stream=AsyncMock()
  await self.b.register({'alias':'one','session':'fixture','allowed':[],'allow_existing_member_groups':True})
 async def asyncTearDown(self):await self.b.shutdown();self.tmp.cleanup()
 async def test_existing_group_member_can_be_granted_without_widening_owner_allowlist(self):
  result=await self.b.existing_group_accounts({'chat_id':-1});self.assertEqual(result['accounts'],[{'alias':'one','user_id':55}]);await self.b.lease(-1);self.assertEqual(self.b.accounts['one']['allowed'],[]);self.client.join_chat.assert_not_awaited();self.assertNotIn('user_id',str(self.b.public_accounts(-1)))
 async def test_channels_and_nonmembers_are_never_granted(self):
  self.client.get_chat.return_value.type='channel';self.assertEqual((await self.b.existing_group_accounts({'chat_id':-1}))['accounts'],[])
  self.client.get_chat.return_value.type='supergroup';self.client.get_chat_member.return_value.status='left';self.assertEqual((await self.b.existing_group_accounts({'chat_id':-1}))['accounts'],[])
 async def test_owner_deny_overrides_existing_membership(self):
  self.b.accounts['one']['denied']=['-1'];self.assertEqual((await self.b.existing_group_accounts({'chat_id':-1}))['accounts'],[]);self.client.get_chat_member.assert_not_awaited()
 async def test_policy_is_opt_in_and_group_scoped(self):
  self.b.accounts['one']['member_fallback_enabled']=False;self.assertEqual((await self.b.existing_group_accounts({'chat_id':-1}))['accounts'],[])
  with self.assertRaises(M.VoiceFailure):await self.b.lease(-1)
 async def test_membership_is_rechecked_before_using_a_group_grant(self):
  await self.b.existing_group_accounts({'chat_id':-1});self.client.get_chat_member.return_value.status='left'
  with self.assertRaises(M.VoiceFailure):await self.b.lease(-1)
  self.assertNotIn(-1,self.b.accounts['one']['group_grants'])
 async def test_fallback_never_allows_joining_an_unapproved_group(self):
  await self.b.existing_group_accounts({'chat_id':-1})
  with self.assertRaises(M.VoiceFailure):await self.b.setup({'chat_id':-1,'stage':'join','invite_link':'https://t.me/+fixture_invite'})
  self.client.join_chat.assert_not_awaited()
 async def test_stop_removes_only_its_ephemeral_group_grant(self):
  await self.b.existing_group_accounts({'chat_id':-1});await self.b.existing_group_accounts({'chat_id':-2});await self.b.setup({'chat_id':-1,'stage':'manage'});await self.b.control('stop',{'chat_id':-1,'leave_membership':True});self.assertNotIn(-1,self.b.accounts['one']['group_grants']);self.assertIn(-2,self.b.accounts['one']['group_grants'])
 async def test_native_failure_retains_safe_class_diagnostics_without_exception_details(self):
  self.b.accounts['one']['allowed']=['-1'];self.b.stream.side_effect=RuntimeError('private-session-fixture-do-not-print')
  with self.assertRaises(RuntimeError):await self.b.play({'chat_id':-1,'stream_url':str(self.file),'playback_id':'test','duration_seconds':2})
  status=await self.b.status(-1);self.assertEqual(status['last_failure']['kind'],'RuntimeError');self.assertNotIn('private-session-fixture',str(status))
