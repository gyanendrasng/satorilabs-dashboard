# Planner test results

**Run at**: 2026-05-31T12:14:43.115Z
**Result**: 8/10 passed (2 failed)

| Case | Result | Duration | Failures |
|---|---|---|---|
| [release_all_no_change](./release_all_no_change.md) | ✅ PASS | 21.5s |  |
| [modify_increase_pre_ls](./modify_increase_pre_ls.md) | ✅ PASS | 36.1s |  |
| [modify_decrease_pre_ls](./modify_decrease_pre_ls.md) | ✅ PASS | 21.3s |  |
| [modify_delete_pre_ls](./modify_delete_pre_ls.md) | ✅ PASS | 22.7s |  |
| [modify_inc_dec_pre_ls](./modify_inc_dec_pre_ls.md) | ✅ PASS | 37.1s |  |
| [modify_inc_del_pre_ls](./modify_inc_del_pre_ls.md) | ✅ PASS | 38.4s |  |
| [modify_dec_del_pre_ls](./modify_dec_del_pre_ls.md) | ✅ PASS | 22.2s |  |
| [modify_decrease_post_ls](./modify_decrease_post_ls.md) | ❌ FAIL | 33.1s | SAP transaction sequence missing: ZLOAD2, ZLOAD3-B1, VTO1N-B. Actual order: ZSO-VISIBILITY → ZLOAD1 → ZLOAD3-B1 → VTO1N-B |
| [modify_delete_post_ls](./modify_delete_post_ls.md) | ✅ PASS | 32.1s |  |
| [modify_increase_post_ls](./modify_increase_post_ls.md) | ❌ FAIL | 75.4s | Step 8: no outbound email of type "plant_ls" appeared within 30000ms |
