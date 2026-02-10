//Path: src/api/payments.router.ts
import express, { Request, Response, Router } from 'express';
import { ApiResponseBuilder } from '../utils/api-combiner.builder';

export default class Payments {
    private readonly router: Router;

    constructor () {
        this.router = express.Router();
        this.dashboardSummary();
    }
    public get route(): Router { return this.router; }

    // GET /api-payments/dashboard/summary?months=12&currency=LKR
    private dashboardSummary(): void {
        this.router.get( '/dashboard/summary', ( req: Request, res: Response ) => {
            const currency = ( req.query.currency as string ) || 'LKR';
            const data = {
                totals: {
                    collectedAllTime: 0,
                    mtdCollected: 0,
                    outstanding: 0,
                    arrearsCount: 0,
                    refunds: 0
                },
                last12mCollectedSeries: Array( 12 ).fill( 0 ),
                topTenants: [],
                currency
            };
            ApiResponseBuilder.ok( res, 'other', data, 'Payments summary (placeholder)' );
        } );
    }
}