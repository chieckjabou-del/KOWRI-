import { Router } from "express";
import { getAllPools, getPool, checkSlippage, reserveLiquidity, getLiquidityStats, initLiquidityPools } from "../lib/fxLiquidity";

const router = Router();

router.get("/pools", async (_req, res) => {
  try {
    const pools = await getAllPools();
    return res.json({ pools, count: pools.length });
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch liquidity pools" });
  }
});

router.get("/pools/:currency", async (req, res) => {
  try {
    const pool = await getPool(req.params.currency.toUpperCase());
    if (!pool) return res.status(404).json({ error: "Pool not found" });
    return res.json(pool);
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch pool" });
  }
});

router.get("/slippage", async (req, res) => {
  const { base, target, amount } = req.query;
  if (!base || !target || !amount) {
    return res.status(400).json({ error: "base, target, amount required" });
  }
  try {
    const result = await checkSlippage(
      (base as string).toUpperCase(),
      (target as string).toUpperCase(),
      Number(amount)
    );
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: "Slippage calculation failed" });
  }
});

router.post("/reserve", async (req, res) => {
  const { baseCurrency, targetCurrency, amount } = req.body;
  if (!baseCurrency || !targetCurrency || !amount) {
    return res.status(400).json({ error: "baseCurrency, targetCurrency, amount required" });
  }
  try {
    const posId = await reserveLiquidity(baseCurrency.toUpperCase(), targetCurrency.toUpperCase(), Number(amount));
    if (!posId) return res.status(409).json({ error: "Insufficient liquidity" });
    return res.status(201).json({ positionId: posId, baseCurrency, targetCurrency, amount: Number(amount), status: "reserved" });
  } catch (err) {
    return res.status(500).json({ error: "Reservation failed" });
  }
});

router.get("/stats", async (_req, res) => {
  try {
    const stats = await getLiquidityStats();
    return res.json(stats);
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch liquidity stats" });
  }
});

router.post("/pools/init", async (_req, res) => {
  try {
    await initLiquidityPools();
    const pools = await getAllPools();
    return res.json({ initialized: true, poolCount: pools.length });
  } catch (err) {
    return res.status(500).json({ error: "Pool initialization failed" });
  }
});

export default router;
