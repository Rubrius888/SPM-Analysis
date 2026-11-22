'use strict';

globalThis.spmTrainers = (() => {
  const { clean, identityKey } = spmMetrics;
  const locationFields = ['department', 'workshop', 'section'];

  function fromMatrix(raw) {
    try {
      const source = JSON.parse(raw.replace(/^\uFEFF/, ''));
      const { posts, operators, data, postIds } = source.state ?? source;
      if (![posts, operators, data].every(Array.isArray)
        || data.length !== posts.length
        || !posts.every(name => (typeof name === 'string' || typeof name === 'number') && clean(name))
        || !data.every(row => Array.isArray(row) && row.length === operators.length)) return null;

      const useIds = Array.isArray(postIds) && postIds.length === posts.length
        && postIds.every(id => typeof id === 'string' && id.trim()) && new Set(postIds).size === posts.length;
      return posts.map((name, index) => ({
        name: clean(name),
        id: useIds ? postIds[index] : null,
        covered: data[index].includes('U')
      }));
    } catch {
      return null;
    }
  }

  function mergeLocation(records) {
    const posts = records.flatMap(record => record.trainerPosts.map(post => ({ ...post, recordIndex: record.id })));
    const byId = new Map();
    const byName = new Map();
    const parents = posts.map((_, index) => index);
    function root(index) {
      while (parents[index] !== index) {
        parents[index] = parents[parents[index]];
        index = parents[index];
      }
      return index;
    }
    function group(map, key, index) {
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(index);
    }
    function merge(indices) {
      const first = root(indices[0]);
      for (const index of indices.slice(1)) parents[root(index)] = first;
    }
    for (const [index, post] of posts.entries()) {
      if (post.id) group(byId, post.id, index);
      group(byName, identityKey([post.name]), index);
    }
    for (const indices of byId.values()) merge(indices);
    for (const indices of byName.values()) {
      const matrices = new Set(indices.map(index => posts[index].recordIndex));
      if (indices.length === matrices.size) merge(indices);
    }

    const clusters = new Map();
    for (const index of posts.keys()) group(clusters, root(index), index);
    for (const indices of clusters.values()) {
      if (new Set(indices.map(index => posts[index].recordIndex)).size < indices.length) return null;
    }
    for (const indices of byName.values()) {
      const matrices = new Set(indices.map(index => posts[index].recordIndex));
      if (matrices.size < 2 || indices.length === matrices.size) continue;
      const groups = new Set(indices.map(root));
      // Duplicate labels within a matrix can only be resolved across shifts by stable identity.
      if ([...groups].some(key => {
        const matched = new Set(clusters.get(key).map(index => posts[index].recordIndex));
        return [...matrices].some(matrix => !matched.has(matrix));
      })) {
        return null;
      }
    }

    const scope = records[0];
    return [...clusters.values()].map(indices => {
      const post = posts[indices[0]];
      const names = [...new Set(indices.map(index => posts[index].name))];
      return {
        department: scope.department, workshop: scope.workshop, section: scope.section,
        name: names.join(' / '), id: post.id,
        covered: indices.some(index => posts[index].covered)
      };
    });
  }

  function aggregate(records) {
    if (!records.length || records.some(record => !Array.isArray(record.trainerPosts))) return null;
    const locations = Map.groupBy(records, record => identityKey(locationFields.map(field => record[field])));
    let total = 0;
    const uncovered = [];
    for (const location of locations.values()) {
      const posts = mergeLocation(location);
      if (!posts) return null;
      total += posts.length;
      uncovered.push(...posts.filter(post => !post.covered));
    }
    const covered = total - uncovered.length;
    return { total, covered, uncovered, coveragePercent: total ? Math.round(covered / total * 100) : 0 };
  }

  return { fromMatrix, aggregate };
})();
