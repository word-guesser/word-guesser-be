import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { authMiddleware } from '../middleware/auth';
import { generateWordPair, saveGeneratedWordPair } from '../services/genaiService';

const router = Router();

router.use(authMiddleware);

// GET /words/categories - List all categories
router.get('/categories', async (_req: Request, res: Response) => {
  const categories = await prisma.wordCategory.findMany({
    include: { _count: { select: { wordPairs: true } } },
    orderBy: { name: 'asc' },
  });
  res.json({ categories });
});

// GET /words - List all word pairs (admin/debug use)
router.get('/', async (req: Request, res: Response) => {
  const { categoryId, page = '1', limit = '20' } = req.query as Record<string, string>;
  const skip = (parseInt(page) - 1) * parseInt(limit);

  const where = categoryId ? { categoryId } : {};
  const [pairs, total] = await Promise.all([
    prisma.wordPair.findMany({
      where,
      include: { category: true },
      skip,
      take: parseInt(limit),
      orderBy: { createdAt: 'desc' },
    }),
    prisma.wordPair.count({ where }),
  ]);

  res.json({ pairs, total, page: parseInt(page), limit: parseInt(limit) });
});

// POST /words - Manually add a word pair
router.post('/', async (req: Request, res: Response) => {
  const { wordA, wordB, categoryName } = req.body as {
    wordA: string;
    wordB: string;
    categoryName: string;
  };

  if (!wordA || !wordB || !categoryName) {
    res.status(400).json({ message: 'Vui lòng điền đầy đủ cặp từ và danh mục.' });
    return;
  }

  let category = await prisma.wordCategory.findUnique({ where: { name: categoryName } });
  if (!category) {
    category = await prisma.wordCategory.create({ data: { name: categoryName } });
  }

  const pair = await prisma.wordPair.create({
    data: { wordA, wordB, categoryId: category.id },
    include: { category: true },
  });

  res.status(201).json({ message: 'Thêm cặp từ thành công.', pair });
});

// POST /words/generate - Generate a word pair using AI
router.post('/generate', async (req: Request, res: Response) => {
  const { categoryName } = req.body as { categoryName: string };

  if (!categoryName) {
    res.status(400).json({ message: 'Vui lòng nhập danh mục.' });
    return;
  }

  const generated = await generateWordPair(categoryName);
  if (!generated) {
    res.status(500).json({ message: 'Không thể tạo cặp từ tự động. Vui lòng thử lại.' });
    return;
  }

  const pair = await saveGeneratedWordPair(generated);
  res.status(201).json({ message: 'Tạo cặp từ thành công.', pair });
});

// DELETE /words/:id - Remove a word pair
router.delete('/:id', async (req: Request, res: Response) => {
  const pair = await prisma.wordPair.findUnique({ where: { id: req.params.id } });
  if (!pair) {
    res.status(404).json({ message: 'Không tìm thấy cặp từ.' });
    return;
  }

  await prisma.wordPair.update({ where: { id: req.params.id }, data: { isActive: false } });
  res.json({ message: 'Xoá cặp từ thành công.' });
});

export default router;
