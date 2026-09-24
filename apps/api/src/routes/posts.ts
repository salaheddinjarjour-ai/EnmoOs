import {
  EDITED_COPY_BOUNDS,
  IdParams,
  PostDto,
  PostListQuery,
  PostListResponse,
  UpdatePostCopyRequest,
} from "@enmo/shared";
import { requireCap } from "../plugins/rbac";
import { editCopy, getPost, listPosts } from "../services/posts";
import type { RouteModule } from "../types";
import { serviceUserOf } from "./context";

/*
 * Posts (DESIGN §E "posts"). Reads take the viewer too: `currentApproval.canDecide` is per user.
 *   GET   /posts           posts.read      ?clientId&campaignId&status&platform
 *   GET   /posts/:id       posts.read
 *   PATCH /posts/:id/copy  posts.editCopy  422 with BannedWordsErrorDetails on banned words and
 *                                          CopyRuleErrorDetails on a broken Copywriter contract;
 *                                          413 over EDITED_COPY_BOUNDS.bodyMaxBytes; an edit
 *                                          after approval reopens it
 */
export const postsRoutes: RouteModule = (app) => {
  const { deps } = app;

  app.get(
    "/posts",
    {
      onRequest: requireCap("posts.read"),
      schema: { querystring: PostListQuery, response: { 200: PostListResponse } },
    },
    async (request) => ({ items: await listPosts(deps, serviceUserOf(request), request.query) }),
  );

  app.get(
    "/posts/:id",
    {
      onRequest: requireCap("posts.read"),
      schema: { params: IdParams, response: { 200: PostDto } },
    },
    (request) => getPost(deps, serviceUserOf(request), request.params.id),
  );

  app.patch(
    "/posts/:id/copy",
    {
      onRequest: requireCap("posts.editCopy"),
      // A post's copy is a few kilobytes; nothing bigger is read, let alone scanned.
      bodyLimit: EDITED_COPY_BOUNDS.bodyMaxBytes,
      schema: { params: IdParams, body: UpdatePostCopyRequest, response: { 200: PostDto } },
    },
    (request) => editCopy(deps, serviceUserOf(request), request.params.id, request.body),
  );
};
