# Planner test results

**Run at**: 2026-05-31T07:43:07.655Z
**Result**: 8/10 passed (2 failed)

| Case | Result | Duration | Failures |
|---|---|---|---|
| [release_all_no_change](./release_all_no_change.md) | ✅ PASS | 22.1s |  |
| [modify_increase_pre_ls](./modify_increase_pre_ls.md) | ✅ PASS | 36.0s |  |
| [modify_decrease_pre_ls](./modify_decrease_pre_ls.md) | ✅ PASS | 20.8s |  |
| [modify_delete_pre_ls](./modify_delete_pre_ls.md) | ✅ PASS | 20.4s |  |
| [modify_inc_dec_pre_ls](./modify_inc_dec_pre_ls.md) | ✅ PASS | 35.8s |  |
| [modify_inc_del_pre_ls](./modify_inc_del_pre_ls.md) | ✅ PASS | 37.6s |  |
| [modify_dec_del_pre_ls](./modify_dec_del_pre_ls.md) | ✅ PASS | 22.0s |  |
| [modify_decrease_post_ls](./modify_decrease_post_ls.md) | ❌ FAIL | 41.1s | Expected SO.status="completed", got "ls_created"; SAP transaction sequence missing: ZLOAD3-B1, VTO1N-B. Actual order: ZSO-VISIBILITY → ZLOAD1 → ZLOAD2 |
| [modify_delete_post_ls](./modify_delete_post_ls.md) | ✅ PASS | 29.5s |  |
| [modify_increase_post_ls](./modify_increase_post_ls.md) | ❌ FAIL | 49.2s | SAP transaction sequence missing: ZLOAD2, ZLOAD3-B1, VTO1N-B. Actual order: ZSO-VISIBILITY → ZLOAD1 → VA02 → ZSO-VISIBILITY → ZLOAD3-B1 → VTO1N-B |
