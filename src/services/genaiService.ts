import { GoogleGenerativeAI } from '@google/generative-ai';
import { prisma } from '../lib/prisma';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

export interface GeneratedWordPair {
  wordA: string;
  wordB: string;
  categoryName: string;
}

/**
 * Use Gemini to generate a new word pair for a given category.
 * Falls back gracefully if the API call fails.
 */
export async function generateWordPair(categoryName: string): Promise<GeneratedWordPair | null> {
  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

    const prompt = `Bạn là trợ lý cho trò chơi đoán từ tiếng Việt (tương tự Undercover).
Hãy tạo một cặp từ liên quan trong danh mục: "${categoryName}".
- Hai từ phải cùng danh mục, gần nghĩa nhưng không giống nhau.
- Ví dụ cặp từ tốt: "quả dâu tây - quả cherry", "móng tay - móng chân", "sư tử - hổ".
- Trả lời CHÍNH XÁC theo định dạng JSON sau, không thêm giải thích:
{
  "wordA": "từ thứ nhất",
  "wordB": "từ thứ hai"
}`;

    const result = await model.generateContent(prompt);
    const text = result.response.text().trim();

    // Extract JSON from response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Invalid AI response format');

    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed.wordA || !parsed.wordB) throw new Error('Missing word fields');

    return {
      wordA: parsed.wordA,
      wordB: parsed.wordB,
      categoryName,
    };
  } catch (error) {
    console.error('[GenAI] Failed to generate word pair:', error);
    return null;
  }
}

/**
 * Pick a random active word pair from the database.
 */
export async function getRandomWordPair(categoryId?: string) {
  const where = categoryId
    ? { isActive: true, categoryId }
    : { isActive: true };

  const count = await prisma.wordPair.count({ where });
  if (count === 0) return null;

  const skip = Math.floor(Math.random() * count);
  const pair = await prisma.wordPair.findFirst({
    where,
    skip,
    include: { category: true },
  });

  return pair;
}

/**
 * Save an AI-generated word pair into the database.
 */
export async function saveGeneratedWordPair(pair: GeneratedWordPair) {
  let category = await prisma.wordCategory.findUnique({
    where: { name: pair.categoryName },
  });

  if (!category) {
    category = await prisma.wordCategory.create({
      data: { name: pair.categoryName },
    });
  }

  return prisma.wordPair.create({
    data: {
      wordA: pair.wordA,
      wordB: pair.wordB,
      categoryId: category.id,
    },
    include: { category: true },
  });
}
