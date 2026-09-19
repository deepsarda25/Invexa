import { Elysia, t } from "elysia";
import { authenticate } from "../lib/auth";
import { LeagueService } from "../domain/leagues/LeagueService";

/**
 * leaguesModule — user-created ranking groups joined via a shared code.
 *
 * Every route here is member-gated: a league's standings, member list and
 * code are only ever visible to people who are already in it. There's
 * deliberately no public directory and no "browse leagues" endpoint — the
 * code is the entire access control mechanism, so anything that let a
 * non-member read a league would undermine it.
 */
export const leaguesModule = new Elysia({ prefix: "/leagues" })
  // ── My leagues ──
  .get("/", async (ctx: any) => {
    const { user } = await authenticate(ctx as any);
    return { leagues: await LeagueService.listForUser(user.id) };
  })

  // ── Create ──
  .post(
    "/",
    async (ctx: any) => {
      const { user } = await authenticate(ctx as any);
      const body = ctx.body as any;

      const league = await LeagueService.createLeague({
        ownerId: user.id,
        name: body.name,
        description: body.description ?? null,
        maxMembers: body.maxMembers ?? null
      });

      ctx.set.status = 201;
      return { league };
    },
    {
      body: t.Object({
        name: t.String({ minLength: 3, maxLength: 60 }),
        description: t.Optional(t.String({ maxLength: 280 })),
        maxMembers: t.Optional(t.Nullable(t.Integer({ minimum: 2, maximum: 500 })))
      })
    }
  )

  // ── Join by code ──
  .post(
    "/join",
    async (ctx: any) => {
      const { user } = await authenticate(ctx as any);
      const { league, alreadyMember } = await LeagueService.joinByCode((ctx.body as any).code, user.id);

      return {
        league,
        alreadyMember,
        message: alreadyMember
          ? `You're already in ${league.name}.`
          : `Welcome to ${league.name} — you're ranked from today's portfolio value.`
      };
    },
    {
      body: t.Object({
        code: t.String({ minLength: 1, maxLength: 20 })
      })
    }
  )

  // ── Single league ──
  .get("/:id", async (ctx: any) => {
    const { user } = await authenticate(ctx as any);
    await LeagueService.assertMember(ctx.params.id, user.id);

    const league = await LeagueService.getLeagueForUser(ctx.params.id, user.id);
    if (!league) throw new Error("League not found.");
    return { league };
  })

  // ── Leaderboard ──
  .get("/:id/leaderboard", async (ctx: any) => {
    const { user } = await authenticate(ctx as any);
    await LeagueService.assertMember(ctx.params.id, user.id);

    const [league, leaderboard] = await Promise.all([
      LeagueService.getLeagueForUser(ctx.params.id, user.id),
      LeagueService.getLeaderboard(ctx.params.id, user.id)
    ]);

    return {
      league,
      leaderboard,
      you: leaderboard.find((row) => row.isYou) ?? null,
      updatedAt: new Date().toISOString()
    };
  })

  // ── Settings (owner) ──
  .patch(
    "/:id",
    async (ctx: any) => {
      const { user } = await authenticate(ctx as any);
      const body = ctx.body as any;

      const league = await LeagueService.updateSettings(ctx.params.id, user.id, {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.isOpen !== undefined ? { isOpen: body.isOpen } : {}),
        ...(body.maxMembers !== undefined ? { maxMembers: body.maxMembers } : {})
      });

      return { league };
    },
    {
      body: t.Object({
        name: t.Optional(t.String({ minLength: 3, maxLength: 60 })),
        description: t.Optional(t.Nullable(t.String({ maxLength: 280 }))),
        isOpen: t.Optional(t.Boolean()),
        maxMembers: t.Optional(t.Nullable(t.Integer({ minimum: 2, maximum: 500 })))
      })
    }
  )

  // ── Rotate the join code (owner) ──
  .post("/:id/regenerate-code", async (ctx: any) => {
    const { user } = await authenticate(ctx as any);
    const joinCode = await LeagueService.regenerateJoinCode(ctx.params.id, user.id);
    return { joinCode, message: "New code generated — the previous one no longer works." };
  })

  // ── Leave ──
  .post("/:id/leave", async (ctx: any) => {
    const { user } = await authenticate(ctx as any);
    await LeagueService.leave(ctx.params.id, user.id);
    return { left: true };
  })

  // ── Remove a member (owner) ──
  .delete("/:id/members/:userId", async (ctx: any) => {
    const { user } = await authenticate(ctx as any);
    await LeagueService.removeMember(ctx.params.id, user.id, ctx.params.userId);
    return { removed: true };
  })

  // ── Delete (owner) ──
  .delete("/:id", async (ctx: any) => {
    const { user } = await authenticate(ctx as any);
    await LeagueService.deleteLeague(ctx.params.id, user.id);
    return { deleted: true };
  });
