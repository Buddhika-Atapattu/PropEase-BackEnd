// ============================================================================
// Path: src/KPIs/api/kpi-submission.controller.ts
// ============================================================================

import type { Request, Response } from 'express';

import { KpiIngestService } from '../services/kpi-ingest.service';
import { KpisRuntime } from '../kpis.runtime';

// Validators
import { KpiDealFactValidator } from '../validators/kpi-deal-fact.validator';
import { KpiSatisfactionFactValidator } from '../validators/kpi-satisfaction-fact.validator';
import { KpiMaintenanceEventValidator } from '../validators/kpi-maintenance-event.validator';
import { KpiTeamTaskFactValidator } from '../validators/kpi-team-task-fact.validator';
import { KpiTeamTaskEvidenceValidator } from '../validators/kpi-team-task-evidence.validator';
import { KpiTeamTaskEventValidator } from '../validators/kpi-team-task-event.validator';

// DTO types
import type { KpiDealFactDto } from '../dtos/kpi-deal-fact.dto';
import type { KpiSatisfactionFactDto } from '../dtos/kpi-satisfaction-fact.dto';
import type { KpiMaintenanceEventDto } from '../dtos/kpi-maintenance-event.dto';
import type { KpiTeamTaskFactDto } from '../dtos/kpi-team-task-fact.dto';
import type { KpiTeamTaskEvidenceDto } from '../dtos/kpi-team-task-evidence.dto';
import type { KpiTeamTaskEventDto } from '../dtos/kpi-team-task-event.dto';

// Validator contract
type ParseOk<T> = { ok: true; value: T };
type ParseFail = { ok: false; errors: ReadonlyArray<string> };
type ParseResult<T> = ParseOk<T> | ParseFail;

type Validator<T> = {
  parse(raw: unknown): ParseResult<T>;
};

export class KpiSubmissionController {
  private readonly ingest: KpiIngestService;

  private readonly dealValidator: Validator<KpiDealFactDto>;
  private readonly satisfactionValidator: Validator<KpiSatisfactionFactDto>;
  private readonly maintenanceValidator: Validator<KpiMaintenanceEventDto>;
  private readonly taskValidator: Validator<KpiTeamTaskFactDto>;
  private readonly evidenceValidator: Validator<KpiTeamTaskEvidenceDto>;
  private readonly taskEventValidator: Validator<KpiTeamTaskEventDto>;

  public constructor() {
    // Teaching note:
    // Controller MUST use the singleton SignalBus from runtime.
    // Otherwise: ingest publishes signals to one bus, while realtime bridge listens on another bus.
    const runtime = KpisRuntime.getInstance();
    this.ingest = new KpiIngestService(runtime.getSignalBus());

    this.dealValidator = new KpiDealFactValidator();
    this.satisfactionValidator = new KpiSatisfactionFactValidator();
    this.maintenanceValidator = new KpiMaintenanceEventValidator();
    this.taskValidator = new KpiTeamTaskFactValidator();
    this.evidenceValidator = new KpiTeamTaskEvidenceValidator();
    this.taskEventValidator = new KpiTeamTaskEventValidator();
  }

  // POST /api-kpis/facts/deals
  public async submitDealFact(req: Request, res: Response): Promise<void> {
    await this.handleSubmit(
      req,
      res,
      this.dealValidator,
      (dto) => this.ingest.ingestDealFact(dto),
      'Deal fact stored.',
      'Invalid deal fact payload.',
      'submitDealFact'
    );
  }

  // POST /api-kpis/facts/satisfaction
  public async submitSatisfactionFact(req: Request, res: Response): Promise<void> {
    await this.handleSubmit(
      req,
      res,
      this.satisfactionValidator,
      (dto) => this.ingest.ingestSatisfactionFact(dto),
      'Satisfaction fact stored.',
      'Invalid satisfaction payload.',
      'submitSatisfactionFact'
    );
  }

  // POST /api-kpis/facts/maintenance/events
  public async submitMaintenanceEvent(req: Request, res: Response): Promise<void> {
    await this.handleSubmit(
      req,
      res,
      this.maintenanceValidator,
      (dto) => this.ingest.ingestMaintenanceEvent(dto),
      'Maintenance event stored.',
      'Invalid maintenance event payload.',
      'submitMaintenanceEvent'
    );
  }

  // POST /api-kpis/facts/team/tasks
  public async submitTeamTaskFact(req: Request, res: Response): Promise<void> {
    await this.handleSubmit(
      req,
      res,
      this.taskValidator,
      (dto) => this.ingest.ingestTeamTaskFact(dto),
      'Team task fact stored.',
      'Invalid team task fact payload.',
      'submitTeamTaskFact'
    );
  }

  // POST /api-kpis/facts/team/task-evidence
  public async submitTeamTaskEvidence(req: Request, res: Response): Promise<void> {
    await this.handleSubmit(
      req,
      res,
      this.evidenceValidator,
      (dto) => this.ingest.ingestTeamTaskEvidence(dto),
      'Task evidence fact stored.',
      'Invalid task evidence payload.',
      'submitTeamTaskEvidence'
    );
  }

  // POST /api-kpis/facts/team/task-events
  public async submitTeamTaskEvent(req: Request, res: Response): Promise<void> {
    await this.handleSubmit(
      req,
      res,
      this.taskEventValidator,
      (dto) => this.ingest.ingestTeamTaskEvent(dto),
      'Task event fact stored.',
      'Invalid task event payload.',
      'submitTeamTaskEvent'
    );
  }

  private async handleSubmit<TDto>(
    req: Request,
    res: Response,
    validator: Validator<TDto>,
    ingestFn: (dto: TDto) => Promise<string>,
    successMessage: string,
    badRequestMessage: string,
    logTag: string
  ): Promise<void> {
    try {
      const parsed = validator.parse(req.body);

      if (!parsed.ok) {
        res.status(400).json(this.buildError(badRequestMessage, parsed.errors));
        return;
      }

      const createdId = await ingestFn(parsed.value);

      res.status(201).json(this.buildSuccess(successMessage, { id: createdId }));
      return;
    } catch (err) {
      console.log(`[Error:] [KPI] ${logTag} failed.\n`, err);
      res.status(500).json(this.buildError('Unexpected error while storing KPI fact.'));
      return;
    }
  }

  private buildSuccess(message: string, data?: unknown): Record<string, unknown> {
    const out: Record<string, unknown> = {
      success: true,
      status: 'success',
      message,
      timestamp: new Date().toISOString(),
    };

    if (data !== undefined) out.data = data;
    return out;
  }

  private buildError(message: string, errors?: ReadonlyArray<string>): Record<string, unknown> {
    const out: Record<string, unknown> = {
      success: false,
      status: 'error',
      message,
      timestamp: new Date().toISOString(),
    };

    if (errors && errors.length > 0) out.errors = errors;
    return out;
  }
}
