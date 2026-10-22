export interface QuizFollowUpInput {
  title: string;
  stem: string;
  options: string[];
  selectedIndex: number;
  correct: boolean;
  correctIndex: number | null;
  explanation: string;
}

const optionLetter = (index: number) => String.fromCharCode(65 + index);

export function buildQuizFollowUpPrompt(input: QuizFollowUpInput): string {
  const optionText = input.options.map((option, index) => `${optionLetter(index)}. ${option}`).join('；');
  const selected = input.options[input.selectedIndex]
    ? `${optionLetter(input.selectedIndex)}. ${input.options[input.selectedIndex]}`
    : `选项 ${input.selectedIndex + 1}`;
  const correct = input.correctIndex != null && input.options[input.correctIndex]
    ? `${optionLetter(input.correctIndex)}. ${input.options[input.correctIndex]}`
    : '';
  return [
    '我刚完成一道分阶测试题，请帮我在伴学助手里做一次交互式巩固。',
    `题目：${input.stem || input.title}`,
    `选项：${optionText}`,
    `我选的：${selected}`,
    `判断：${input.correct ? '回答正确' : '回答错误'}`,
    correct ? `正确答案：${correct}` : '',
    input.explanation ? `解析：${input.explanation}` : '',
    '请先简短判断我对这道题的理解是否到位，结合解析讲清关键点；如果我没理解透，请明确指出我该补哪个概念。',
  ].filter(Boolean).join('\n');
}

