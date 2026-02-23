// ============================================================================
// MemberProfileController
// ----------------------------------------------------------------------------
// REST entry for Member Performance Profile (READ ONLY)
// ============================================================================

import type { Request, Response } from 'express';
import { MemberProfileTeamKpiService } from '../services/teamManagement/member-profile.team-kpi.service';

export class MemberProfileController {

  public static async getMemberProfile(req: Request, res: Response): Promise<void> {
    try {
      const memberId: string = String(req.query.memberId ?? '').trim();
      const fromRaw: string = String(req.query.from ?? '').trim();
      const toRaw: string = String(req.query.to ?? '').trim();

      const bucket =
        req.query.bucket === 'day' ||
        req.query.bucket === 'week' ||
        req.query.bucket === 'month'
          ? req.query.bucket
          : 'month';

      const recentLimit: number = Number(req.query.recentLimit ?? 50);

      if (!memberId || !fromRaw || !toRaw) {
        res.status(400).json({
          success: false,
          status: 'error',
          message: 'memberId, from, and to are required',
        });
        return;
      }

      const from = new Date(fromRaw);
      const to = new Date(toRaw);

      if (isNaN(from.getTime()) || isNaN(to.getTime())) {
        res.status(400).json({
          success: false,
          status: 'error',
          message: 'Invalid date format',
        });
        return;
      }

      const profile = await MemberProfileTeamKpiService.buildProfile({
        memberId,
        from,
        to,
        bucket,
        recentLimit,
      });

      res.status(200).json({
        success: true,
        status: 'success',
        message: 'Member profile generated',
        data: profile,
      });
      return;

    } catch (error) {
      console.error('[Error:] MemberProfileController.getMemberProfile\n', error);

      res.status(500).json({
        success: false,
        status: 'error',
        message: 'Failed to generate member profile',
      });
      return;
    }
  }
}
