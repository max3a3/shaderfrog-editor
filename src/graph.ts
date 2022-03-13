import preprocess from '@shaderfrog/glsl-parser/dist/preprocessor';
import { parser, generate } from '@shaderfrog/glsl-parser';
import {
  renameBindings,
  renameFunctions,
} from '@shaderfrog/glsl-parser/dist/parser/utils';
import { ParserProgram } from '@shaderfrog/glsl-parser/dist/parser/parser';
import {
  visit,
  AstNode,
  NodeVisitors,
  Path,
} from '@shaderfrog/glsl-parser/dist/ast';

import {
  ProgramAst,
  ShaderType,
  Graph,
  Node,
  ShaderSections,
  findShaderSections,
  mergeShaderSections,
  shaderSectionsToAst,
  returnGlPositionVec3Right,
  convert300MainToReturn,
  makeExpression,
  from2To3,
  Edge,
  emptyShaderSections,
  ShaderStage,
  returnGlPosition,
  doesLinkThruShader,
  makeFnStatement,
  MergeOptions,
} from './nodestuff';

export interface Engine<T> {
  name: string;
  preserve: Set<string>;
  mergeOptions: MergeOptions;
  // Component: FunctionComponent<{ engine: Engine; parsers: NodeParsers }>;
  // nodes: NodeParsers;
  parsers: Parser<T>;
}

const alphabet = 'abcdefghijklmnopqrstuvwxyz';

export type NodeFiller = (node: Node, ast: AstNode) => AstNode | void;
export const emptyFiller: NodeFiller = () => {};

export type NodeInputs = Record<string, (a: AstNode) => void>;

export type NodeContext = {
  ast: AstNode | ParserProgram;
  source?: string;
  // Inputs are determined at parse time and should probably be in the graph,
  // not here on the runtime context for the node
  inputs?: NodeInputs;
  id?: string;
  name?: string;
};

// The context an engine builds as it evaluates. It can manage its own state
// as the generic "RuntimeContext" which is passed to implemented engine methods
export type EngineContext<RuntimeContext> = {
  engine: string;
  compileCount: 0;
  nodes: Record<string, NodeContext>;
  runtime: RuntimeContext;
  debuggingNonsense: {
    vertexSource?: string;
    vertexPreprocessed?: string;
    fragmentPreprocessed?: string;
    fragmentSource?: string;
  };
};

export type ShaderParser<T> = {
  produceAst: (
    engineContext: EngineContext<T>,
    engine: Engine<T>,
    graph: Graph,
    node: Node,
    inputEdges: Edge[]
  ) => AstNode | ParserProgram;
  findInputs: (
    engineContext: EngineContext<T>,
    node: Node,
    ast: AstNode,
    nodeContext: NodeContext,
    inputEdges: Edge[]
  ) => NodeInputs;
  produceFiller: NodeFiller;
};

export type ProgramParser<T> = {
  onBeforeCompile?: (
    engineContext: EngineContext<T>,
    // engine: Engine<T>,
    node: Node
  ) => void;
  fragment: ShaderParser<T>;
  vertex: ShaderParser<T>;
};

export type NodeParser<T> = ProgramParser<T> | ShaderParser<T>;

export type Parser<T> = Partial<Record<ShaderType, NodeParser<T>>>;

export const nodeName = (node: Node): string =>
  'main_' + node.name.replace(/[^a-zA-Z0-9]/g, ' ').replace(/ +/g, '_');

type Runtime = {};

const binaryNode = <T>(operation: string): NodeParser<T> => ({
  produceAst: (engineContext, engine, graph, node, inputEdges) => {
    const fragmentAst: AstNode = {
      type: 'program',
      program: [
        makeExpression(
          inputEdges.length
            ? inputEdges
                .map((_, index) => alphabet.charAt(index))
                .join(` ${operation} `)
            : `a ${operation} b`
        ),
      ],
      scopes: [],
    };
    return fragmentAst;
  },
  findInputs: (engineContext, node, ast, nodeContext, inputEdges) => {
    return new Array(Math.max(inputEdges.length + 1, 2))
      .fill(0)
      .map((_, index) => alphabet.charAt(index))
      .reduce(
        (inputs, letter) => ({
          ...inputs,
          [letter]: (fillerAst: AstNode) => {
            let foundPath: Path | undefined;
            const visitors: NodeVisitors = {
              identifier: {
                enter: (path) => {
                  if (path.node.identifier === letter) {
                    foundPath = path;
                  }
                },
              },
            };
            visit(nodeContext.ast, visitors);
            if (!foundPath) {
              throw new Error(
                `Im drunk and I think this case is impossible, no "${letter}" found in binary node?`
              );
            }

            if (foundPath.parent && foundPath.key) {
              foundPath.parent[foundPath.key] = fillerAst;
            } else {
              nodeContext.ast = fillerAst;
            }
          },
        }),
        {}
      );
  },
  produceFiller: (node: Node, ast: AstNode): AstNode => {
    return ast.program;
  },
});

export const parsers: Parser<Runtime> = {
  [ShaderType.output]: {
    fragment: {
      produceAst: (engineContext, engine, graph, node, inputEdges) => {
        const fragmentPreprocessed = preprocess(node.source, {
          preserve: {
            version: () => true,
          },
        });
        const fragmentAst = parser.parse(fragmentPreprocessed);
        return fragmentAst;
      },
      findInputs: (engineContext, node, ast) => {
        const assignNode = findVec4Constructor(ast);
        if (!assignNode) {
          throw new Error(`Impossible error, no assign node in output`);
        }
        return {
          color: (fillerAst: AstNode) => {
            assignNode.right = fillerAst;
          },
        };
      },
      produceFiller: emptyFiller,
    },
    vertex: {
      produceAst: (engineContext, engine, graph, node, inputEdges) => {
        const vertexPreprocessed = preprocess(node.source, {
          preserve: {
            version: () => true,
          },
        });
        const vertexAst = parser.parse(vertexPreprocessed);
        return vertexAst;
      },
      findInputs: (engineContext, node, ast) => {
        const assignNode = findAssignmentTo(ast, 'gl_Position');
        if (!assignNode) {
          throw new Error(`Impossible error, no assign node in output`);
        }
        return {
          mainStmts: (fillerAst: AstNode) => {
            ast.program
              .find((stmt: AstNode) => stmt.type === 'function')
              .body.statements.unshift(makeFnStatement(generate(fillerAst)));
          },
          position: (fillerAst: AstNode) => {
            assignNode.expression.right = fillerAst;
          },
        };
      },
      produceFiller: emptyFiller,
    },
  },
  [ShaderType.shader]: {
    fragment: {
      produceAst: (engineContext, engine, graph, node, inputEdges) => {
        const fragmentPreprocessed = preprocess(node.source, {
          preserve: {
            version: () => true,
          },
        });
        const fragmentAst = parser.parse(fragmentPreprocessed);
        from2To3(fragmentAst, 'fragment');

        // Total hack for now
        if (node.originalEngine === 'three' && engine.name === 'babylon') {
          renameBindings(fragmentAst.scopes[0], (name) =>
            name === 'vUv' ? 'vMainUV1' : name === 'vNormal' ? 'vNormalW' : name
          );
        }

        convert300MainToReturn(fragmentAst);
        renameBindings(fragmentAst.scopes[0], (name) =>
          engine.preserve.has(name) ? name : `${name}_${node.id}`
        );
        renameFunctions(fragmentAst.scopes[0], (name) =>
          name === 'main' ? nodeName(node) : `${name}_${node.id}`
        );
        return fragmentAst;
      },
      findInputs: (engineContext, node, ast) => {
        // console.log(util.inspect(ast.program, false, null, true));

        let texture2Dcalls: [AstNode, string][] = [];
        const visitors: NodeVisitors = {
          function_call: {
            enter: (path) => {
              if (
                path.node.identifier?.specifier?.identifier === 'texture2D' &&
                path.key
              ) {
                texture2Dcalls.push([path.node, path.key]);
              }
            },
          },
        };
        visit(ast, visitors);
        return texture2Dcalls.reduce(
          (inputs, [parent, key], index) => ({
            ...inputs,
            [`texture2d_${index}`]: (fillerAst: AstNode) => {
              parent[key] = fillerAst;
            },
          }),
          {}
        );
      },
      produceFiller: (node: Node, ast) => {
        return makeExpression(`${nodeName(node)}()`);
      },
    },
    vertex: {
      produceAst: (engineContext, engine, graph, node, inputEdges) => {
        if (!node.source) {
          return { type: 'empty' };
        }
        const vertexPreprocessed = preprocess(node.source, {
          preserve: {
            version: () => true,
          },
        });
        const vertexAst = parser.parse(vertexPreprocessed);
        from2To3(vertexAst, 'vertex');

        if (doesLinkThruShader(graph, node)) {
          returnGlPositionVec3Right(vertexAst);
        } else {
          returnGlPosition(vertexAst);
        }

        renameBindings(vertexAst.scopes[0], (name) =>
          engine.preserve.has(name) ? name : `${name}_${node.id}`
        );
        renameFunctions(vertexAst.scopes[0], (name) =>
          name === 'main' ? nodeName(node) : `${name}_${node.id}`
        );
        return vertexAst;
      },
      findInputs: (engineContext, node, ast) => ({
        position: (fillerAst: AstNode) => {
          Object.entries(
            (ast.scopes[0].bindings?.position?.references || {}) as Record<
              string,
              AstNode
            >
          )?.forEach(([_, ref]) => {
            if (ref.type === 'identifier' && ref.identifier === 'position') {
              ref.identifier = generate(fillerAst);
            } else if (
              ref.type === 'parameter_declaration' &&
              ref.declaration.identifier.identifier === 'position'
            ) {
              ref.declaration.identifier.identifier = generate(fillerAst);
            }
          });
        },
      }),
      produceFiller: (node: Node, ast) => {
        return makeExpression(`${nodeName(node)}()`);
      },
    },
  },
  [ShaderType.add]: binaryNode('+'),
  [ShaderType.multiply]: binaryNode('*'),
};

const findVec4Constructor = (ast: AstNode): AstNode | undefined => {
  let parent: AstNode | undefined;
  const visitors: NodeVisitors = {
    function_call: {
      enter: (path) => {
        if (path.node.identifier?.specifier?.token === 'vec4') {
          parent = path.findParent((p) => 'right' in p.node)?.node;
          path.skip();
        }
      },
    },
  };
  visit(ast, visitors);
  return parent;
};

export const findAssignmentTo = (
  ast: AstNode,
  assignTo: string
): AstNode | undefined => {
  let assign: AstNode | undefined;
  const visitors: NodeVisitors = {
    expression_statement: {
      enter: (path) => {
        if (path.node.expression?.left?.identifier === assignTo) {
          assign = path.node;
        }
        path.skip();
      },
    },
  };
  visit(ast, visitors);
  return assign;
};

export const collectConnectedNodes = (
  graph: Graph,
  edges: Edge[],
  node: Node,
  ids: NodeIds
): NodeIds => {
  let compiledIds = ids;

  const inputEdges = edges.filter((edge) => edge.to === node.id);
  if (inputEdges.length) {
    inputEdges.forEach((edge) => {
      const fromNode = graph.nodes.find((node) => edge.from === node.id);
      if (!fromNode) {
        throw new Error(`Node for edge ${edge.from} not found`);
      }

      const childIds = collectConnectedNodes(graph, edges, fromNode, ids);
      compiledIds = { ...compiledIds, ...childIds };
    });

    return { ...compiledIds, [node.id]: node };
  } else {
    return { ...compiledIds, [node.id]: node };
  }
};

type NodeIds = Record<string, Node>;
export type CompileNodeResult = [ShaderSections, AstNode | void, NodeIds];

export const compileNode = <T>(
  engine: Engine<T>,
  graph: Graph,
  edges: Edge[],
  engineContext: EngineContext<T>,
  // graphContext: GraphContext,
  node: Node,
  stage: ShaderStage,
  ids: NodeIds
): CompileNodeResult => {
  const parser = engine.parsers[node.type] || parsers[node.type];

  // Will I one day get good enough at typescript to be able to remove this
  // check? Or will I learn that I need it?
  if (!parser) {
    console.error(node);
    throw new Error(
      `No parser found for ${node.name} (${node.type}, id ${node.id})`
    );
  }

  const nodeContext = engineContext.nodes[node.id];
  if (!nodeContext) {
    throw new Error(
      `No node context found for "${node.name}" (id ${node.id})!`
    );
  }
  const { ast, inputs } = nodeContext;
  let compiledIds = ids;

  const inputEdges = edges.filter((edge) => edge.to === node.id);
  if (inputEdges.length) {
    let continuation = emptyShaderSections();
    inputEdges.forEach((edge) => {
      const fromNode = graph.nodes.find((node) => edge.from === node.id);
      if (!fromNode) {
        throw new Error(`Node for edge ${edge.from} not found`);
      }

      const [inputSections, fillerAst, childIds] = compileNode(
        engine,
        graph,
        edges,
        engineContext,
        // graphContext,
        fromNode,
        stage,
        ids
      );
      if (!fillerAst) {
        throw new Error(
          `Expected a filler ast from node ID ${fromNode.id} (${fromNode.type}) but none was returned`
        );
      }

      continuation = mergeShaderSections(continuation, inputSections);
      compiledIds = { ...compiledIds, ...childIds };

      if (!inputs) {
        throw new Error("I'm drunk and I think this case should be impossible");
      }
      if (!(edge.input in inputs)) {
        throw new Error(
          `Node "${node.name}" has no input ${
            edge.input
          }!\nAvailable:${Object.keys(inputs).join(', ')}`
        );
      }
      inputs[edge.input](fillerAst);
      // console.log(generate(ast.program));
    });

    // Order matters here! *Prepend* the input nodes to this one, because
    // you have to declare functions in order of use in GLSL
    const sections = mergeShaderSections(
      continuation,
      // TODO: This and below "as" are bad
      node.expressionOnly
        ? emptyShaderSections()
        : findShaderSections(ast as ParserProgram)
    );

    return [
      sections,
      // @ts-ignore
      (stage in parser ? parser[stage] : parser).produceFiller(node, ast),
      { ...compiledIds, [node.id]: node },
    ];
  } else {
    const sections = node.expressionOnly
      ? emptyShaderSections()
      : findShaderSections(ast as ParserProgram);

    return [
      sections,
      // @ts-ignore
      (stage in parser ? parser[stage] : parser).produceFiller(node, ast),
      { ...compiledIds, [node.id]: node },
    ];
  }
};

const computeNodeContext = <T>(
  engineContext: EngineContext<T>,
  engine: Engine<T>,
  graph: Graph,
  parser: NodeParser<T>,
  node: Node,
  stage?: ShaderStage
): NodeContext => {
  // @ts-ignore
  if (parser.onBeforeCompile) {
    // @ts-ignore
    parser.onBeforeCompile(engineContext, node);
  }

  const inputEdges = graph.edges.filter((edge) => edge.to === node.id);

  // @ts-ignore
  const ast = (stage in parser ? parser[stage] : parser).produceAst(
    engineContext,
    engine,
    graph,
    node,
    inputEdges
  );
  const nodeContext: NodeContext = { ast, id: node.id, name: node.name };
  nodeContext.inputs =
    // @ts-ignore
    (stage in parser ? parser[stage] : parser).findInputs(
      engineContext,
      node,
      ast,
      nodeContext,
      inputEdges
    );

  return nodeContext;
};

const computeSideContext = <T>(
  engineContext: EngineContext<T>,
  engine: Engine<T>,
  graph: Graph,
  nodes: Node[]
  // stage?: ShaderStage
) =>
  // graph.nodes
  //   .filter((node) => node.stage === stage)
  //   .reduce((context, node) => {
  nodes.reduce((context, node) => {
    let parser;
    let nodeContext;

    console.log('computing context for', node.name);
    // User parser
    if ((parser = engine.parsers[node.type])) {
      nodeContext = computeNodeContext(
        engineContext,
        engine,
        graph,
        parser,
        node,
        node.stage
      );
      // Internal parser
    } else if ((parser = parsers[node.type])) {
      nodeContext = computeNodeContext(
        engineContext,
        engine as unknown as Engine<Runtime>,
        graph,
        parser,
        node,
        node.stage
      );
    } else {
      throw new Error(`No parser for ${node.type}`);
    }

    context[node.id] = {
      ...(context[node.id] || {}),
      ...nodeContext,
    };
    return context;
  }, engineContext.nodes);

export type CompileGraphResult = {
  fragment: ShaderSections;
  vertex: ShaderSections;
};

export const computeAllContexts = <T>(
  engineContext: EngineContext<T>,
  engine: Engine<T>,
  graph: Graph
) => {
  computeSideContext(engineContext, engine, graph, graph.nodes);
};

export const computeGraphContext = <T>(
  engineContext: EngineContext<T>,
  engine: Engine<T>,
  graph: Graph
) => {
  const outputFrag = graph.nodes.find(
    (node) => node.type === 'output' && node.stage === 'fragment'
  );
  if (!outputFrag) {
    throw new Error('No fragment output in graph');
  }
  const outputVert = graph.nodes.find(
    (node) => node.type === 'output' && node.stage === 'vertex'
  );
  if (!outputVert) {
    throw new Error('No vertex output in graph');
  }

  const vertexIds = collectConnectedNodes(graph, graph.edges, outputVert, {});
  const fragmentIds = collectConnectedNodes(graph, graph.edges, outputFrag, {});
  const additionalIds = graph.nodes.filter(
    (node) =>
      node.stage === 'vertex' &&
      node.nextStageNodeId &&
      fragmentIds[node.nextStageNodeId] &&
      !vertexIds[node.id]
  );

  computeSideContext(engineContext, engine, graph, [
    outputFrag,
    ...Object.values(fragmentIds),
  ]);
  computeSideContext(engineContext, engine, graph, [
    outputVert,
    ...Object.values(vertexIds),
    ...additionalIds,
  ]);
  // computeSideContext(engineContext, engine, graph, 'fragment');
  // computeSideContext(engineContext, engine, graph, 'vertex');
};

export const compileGraph = <T>(
  engineContext: EngineContext<T>,
  engine: Engine<T>,
  graph: Graph
): CompileGraphResult => {
  computeGraphContext(engineContext, engine, graph);

  const outputFrag = graph.nodes.find(
    (node) => node.type === 'output' && node.stage === 'fragment'
  );
  if (!outputFrag) {
    throw new Error('No fragment output in graph');
  }

  const [fragment, , fragmentIds] = compileNode(
    engine,
    graph,
    graph.edges,
    engineContext,
    outputFrag,
    'fragment',
    {}
  );

  const outputVert = graph.nodes.find(
    (node) => node.type === 'output' && node.stage === 'vertex'
  );
  if (!outputVert) {
    throw new Error('No vertex output in graph');
  }

  const vertexIds = collectConnectedNodes(graph, graph.edges, outputVert, {});
  const orphanEdges: Edge[] = graph.nodes
    .filter(
      (node) =>
        node.stage === 'vertex' &&
        node.nextStageNodeId &&
        fragmentIds[node.nextStageNodeId] &&
        !vertexIds[node.id]
    )
    .map((node) => ({
      from: node.id,
      to: outputVert.id,
      output: 'main',
      input: 'mainStmts',
      stage: 'vertex',
    }));

  const [vertex, ,] = compileNode(
    engine,
    graph,
    [...graph.edges, ...orphanEdges],
    engineContext,
    outputVert,
    'vertex',
    {}
  );

  // Imperative hack :( to allow engines to know some unique id of compilation
  engineContext.compileCount++;

  // Every compileNode returns the AST so far, as well as the filler for the
  // next node with inputs. On the final step, we discard the filler
  return {
    fragment,
    vertex,
  };
};
