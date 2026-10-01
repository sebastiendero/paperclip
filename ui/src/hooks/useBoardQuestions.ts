import { useQuery } from "@tanstack/react-query";
import { attentionApi } from "../api/attention";
import { queryKeys } from "../lib/queryKeys";

/**
 * What is waiting on the signed-in board user in this company: pending thread
 * cards addressed to them and board approval stages. Shared by the Inbox
 * "Questions" tab and the sidebar badge (same query key, one request).
 */
export function useBoardQuestions(companyId: string | null | undefined) {
  return useQuery({
    queryKey: queryKeys.boardQuestions(companyId ?? "__none__"),
    queryFn: () => attentionApi.boardQuestions(companyId!),
    enabled: !!companyId,
    // Live updates invalidate on card and issue events; the poll is a backstop.
    refetchInterval: 60_000,
  });
}
