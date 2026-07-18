import { t } from "elysia";

/** :reelId path param for per-reel distribution actions. */
export const ReelIdParams = t.Object({ reelId: t.String() });
export type TReelIdParams = typeof ReelIdParams.static;

/** :reelId + :channelId path params (publish/comment on a specific account). */
export const ReelChannelParams = t.Object({ reelId: t.String(), channelId: t.String() });
export type TReelChannelParams = typeof ReelChannelParams.static;

/** Body for publishing one reel to one platform account. */
export const PublishToChannelBody = t.Object({ channelId: t.String({ minLength: 1 }) });
export type TPublishToChannelBody = typeof PublishToChannelBody.static;

/** Query for reading comments on an own published post. `limit` is a string
 *  (query params are strings) parsed by the controller. */
export const ReelCommentsQuery = t.Object({
  channelId: t.String({ minLength: 1 }),
  limit: t.Optional(t.String()),
});
export type TReelCommentsQuery = typeof ReelCommentsQuery.static;

/** Body for (re)posting the own-post first comment. YouTube channel optional. */
export const PostFirstCommentBody = t.Object({ channelId: t.Optional(t.String({ minLength: 1 })) });
export type TPostFirstCommentBody = typeof PostFirstCommentBody.static;

/** Body for replying to a comment on an own post. */
export const ReplyCommentBody = t.Object({
  channelId: t.String({ minLength: 1 }),
  commentId: t.String({ minLength: 1 }),
  message: t.String({ minLength: 1, maxLength: 1000 }),
});
export type TReplyCommentBody = typeof ReplyCommentBody.static;
