"""Offline tests for multi-assistant concurrent video leasing and dual-assistant subtitle tiles."""
import importlib.util
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import AsyncMock

SPEC = importlib.util.spec_from_file_location('multi_voice', Path(__file__).resolve().parents[1] / 'main.py')
M = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(M)


class MultiAssistantAndDualTileTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.vid = Path(self.tmp.name) / 'movie.mp4'
        self.vid.write_bytes(b'fixture-video')
        self.sub_en = Path(self.tmp.name) / 'en.srt'
        self.sub_en.write_text('1\n00:00:01,000 --> 00:00:03,000\nHello world\n', encoding='utf-8')
        self.sub_es = Path(self.tmp.name) / 'es.srt'
        self.sub_es.write_text('1\n00:00:01,000 --> 00:00:03,000\nHola mundo\n', encoding='utf-8')

        self.engines = {}
        self.clients = {}

        async def factory(alias, _session):
            uid = 101 if alias == 'player_one' else 102
            client = types.SimpleNamespace(
                get_me=AsyncMock(return_value=types.SimpleNamespace(id=uid, is_bot=False)),
                get_chat=AsyncMock(return_value=types.SimpleNamespace(type='supergroup')),
                get_chat_member=AsyncMock(return_value=types.SimpleNamespace(status='administrator')),
                stop=AsyncMock(),
            )
            engine = types.SimpleNamespace(
                play=AsyncMock(),
                pause=AsyncMock(),
                resume=AsyncMock(),
                leave_call=AsyncMock(),
                time=AsyncMock(return_value=42),
            )
            self.clients[alias] = client
            self.engines[alias] = engine
            return client, engine, uid

        self.b = M.Bridge(self.tmp.name, factory=factory)
        self.b.stream = AsyncMock()
        await self.b.register({'alias': 'player_one', 'session': 's1', 'allowed': ['*']})
        await self.b.register({'alias': 'player_two', 'session': 's2', 'allowed': ['*']})

    async def asyncTearDown(self):
        await self.b.shutdown()
        self.tmp.cleanup()

    async def test_concurrent_separate_movies_balance_across_assistants_and_enforce_cap(self):
        r1 = await self.b.play({
            'chat_id': -1001,
            'stream_url': str(self.vid),
            'playback_id': 'p1',
            'video': True,
            'duration_seconds': 3600,
            'max_video_calls_per_account': 1,
        })
        r2 = await self.b.play({
            'chat_id': -1002,
            'stream_url': str(self.vid),
            'playback_id': 'p2',
            'video': True,
            'duration_seconds': 3600,
            'max_video_calls_per_account': 1,
        })
        self.assertNotEqual(r1['account_alias'], r2['account_alias'])
        self.assertEqual({r1['account_alias'], r2['account_alias']}, {'player_one', 'player_two'})

        with self.assertRaises(M.VoiceFailure) as ctx:
            await self.b.play({
                'chat_id': -1003,
                'stream_url': str(self.vid),
                'playback_id': 'p3',
                'video': True,
                'duration_seconds': 3600,
                'max_video_calls_per_account': 1,
            })
        self.assertEqual(ctx.exception.code, 'POOL_EXHAUSTED')

        await self.b.control('stop', {'chat_id': -1001})
        r3 = await self.b.play({
            'chat_id': -1003,
            'stream_url': str(self.vid),
            'playback_id': 'p3',
            'video': True,
            'duration_seconds': 3600,
            'max_video_calls_per_account': 1,
        })
        self.assertEqual(r3['account_alias'], r1['account_alias'])

    async def test_dual_assistant_secondary_subtitle_tile_lifecycle_and_guards(self):
        await self.b.play({
            'chat_id': -1001,
            'stream_url': str(self.vid),
            'playback_id': 'p1',
            'video': True,
            'subtitle_path': str(self.sub_en),
            'duration_seconds': 3600,
            'max_video_calls_per_account': 1,
        })
        primary_alias = self.b.calls[-1001]['alias']
        tile_res = await self.b.start_secondary_tile({
            'chat_id': -1001,
            'subtitle_path': str(self.sub_es),
            'language': 'spa',
            'label': 'Spanish Subtitles',
            'max_video_calls_per_account': 1,
        })
        self.assertTrue(tile_res['ok'])
        self.assertNotEqual(tile_res['account_alias'], primary_alias)
        self.assertIn(-1001, self.b.secondary_tiles)

        st = await self.b.status(-1001)
        self.assertEqual(st['info']['secondary_tile']['language'], 'spa')

        await self.b.control('pause', {'chat_id': -1001})
        self.assertEqual(self.b.secondary_tiles[-1001]['status'], 'paused')
        self.engines[tile_res['account_alias']].pause.assert_awaited_once_with(-1001)

        await self.b.control('resume', {'chat_id': -1001})
        self.assertEqual(self.b.secondary_tiles[-1001]['status'], 'playing')
        self.engines[tile_res['account_alias']].resume.assert_awaited_once_with(-1001)

        await self.b.control('stop', {'chat_id': -1001})
        self.assertNotIn(-1001, self.b.secondary_tiles)

        # Channel calls must reject secondary tile
        await self.b.play({
            'chat_id': -1009,
            'stream_url': str(self.vid),
            'playback_id': 'pc',
            'video': True,
            'is_channel': True,
            'duration_seconds': 3600,
        })
        with self.assertRaises(M.VoiceFailure) as ch_err:
            await self.b.start_secondary_tile({'chat_id': -1009, 'subtitle_path': str(self.sub_es)})
        self.assertEqual(ch_err.exception.code, 'INVALID_REQUEST')


if __name__ == '__main__':
    unittest.main()
