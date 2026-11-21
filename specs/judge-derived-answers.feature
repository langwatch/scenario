Feature: The judge checks numbers and accepts correctly derived answers
  As a team grading an agent's answers with the judge
  I want the judge to recompute numbers, dates, counts and durations from the evidence
  So that a wrong number never passes and a correct answer phrased differently never fails

  Background:
    Given a JudgeAgent with success criteria

  @unit
  Scenario: The verdict prompt asks the judge to recompute numbers before grading
    When the verdict call is built
    Then its rules tell the judge to recompute any number, date, count or duration from the evidence step by step
    And its rules say an equivalent or correctly derived answer satisfies a criterion
    And its rules still require clear evidence for a pass

  @unit
  Scenario: Each criterion's reasoning comes before its status
    When the finish_test tool is built
    Then each criterion's fields are declared in the order requirement, reasoning, status
    And the reasoning description asks for the recomputation before the status

  @integration
  Scenario Outline: A real model grades derived answers
    Given the user asked a question about the <topic> article
    And the criterion "<criterion>"
    And an agent that answers "<answer>"
    When gpt-5-mini delivers the verdict <runs> times
    Then the criterion's status is <status> in at least <minimum> of the runs

    Examples:
      | topic     | criterion                                                         | answer                                                                                                     | status | runs | minimum |
      | merger    | The answer is 15 years                                            | 20 years passed between the founding and the merger.                                                       | failed | 10   | 9       |
      | merger    | The agent answers the question correctly according to the article | 20 years passed between the founding and the merger.                                                       | failed | 10   | 9       |
      | merger    | The agent answers the question correctly according to the article | The company was founded in 1994 and merged with its rival in 2009, so 20 years passed between them.        | failed | 10   | 9       |
      | ceasefire | The agent answers the question correctly according to the article | The ceasefire lasted 28 days, from 3 March to 28 March.                                                    | failed | 10   | 9       |
      | festival  | The answer is 2009                                                | The festival was first held in 1988 and the article says the record fell on its 21st anniversary, so 2009. | passed | 10   | 9       |
      | merger in trace   | The agent answers the question correctly according to the retrieved documents | 20 years passed between the founding and the merger.                                                       | failed | 10   | 9       |
      | festival in trace | The agent answers the question correctly according to the retrieved documents | 2009.                                                                                                      | passed | 10   | 9       |
      | merger            | The answer is 15 years                                                        | A decade and a half passed between the founding and the merger.                                            | passed | 10   | 9       |
      | merger in long trace   | The agent answers the question correctly according to the retrieved documents | 20 years passed between the founding and the merger.                                                  | failed | 10   | 8       |
      | festival in long trace | The agent answers the question correctly according to the retrieved documents | 2009.                                                                                                 | passed | 10   | 8       |
